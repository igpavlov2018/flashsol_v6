/**
 * routes/registry.ts — API эндпоинты для регистрации и депозитов
 *
 * Исправления безопасности:
 * 1. payload кешируется между prepare и confirm (ключ = wallet+levelId)
 * 2. Верификация проверяет суммы И адреса получателей on-chain
 * 3. Race condition защищён через SELECT FOR UPDATE в recordDeposit
 * 4. Все критические операции обёрнуты в транзакции БД
 */

import { Router } from 'express';
import {
  registerUser,
  validateDepositLevel,
  buildReferralChain,
  recordDeposit,
  getUser,
  getUserReferrals,
  getGlobalStats,
  LEVEL_AMOUNTS,
  LEVEL_NAMES,
  REF_BPS,
} from '../registry';
import { buildCascadePayload, verifyTransactionStrict, TransferInstruction } from '../cascade';
import { cache } from '../utils/cache';
import { logger } from '../utils/logger';

export const registryRouter = Router();

// TTL для кеша payload: 10 минут (достаточно для подписи в Phantom)
const PAYLOAD_TTL = 10 * 60;

// ── POST /api/register ────────────────────────────────────────────────────────
registryRouter.post('/register', async (req, res) => {
  try {
    const { wallet, referrer } = req.body;
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({ ok: false, error: 'wallet required' });
    }
    const result = await registerUser(wallet, referrer || null);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, user: result.user });
  } catch (e) {
    logger.error('POST /register error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

// ── POST /api/deposit/prepare ─────────────────────────────────────────────────
// Строит транзакцию и кеширует payload.
// Кеш живёт 10 минут — достаточно для подписи в Phantom.
registryRouter.post('/deposit/prepare', async (req, res) => {
  try {
    const { wallet, levelId } = req.body;
    if (!wallet || levelId === undefined) {
      return res.status(400).json({ ok: false, error: 'wallet and levelId required' });
    }
    if (![0, 1, 2, 3].includes(Number(levelId))) {
      return res.status(400).json({ ok: false, error: 'Invalid levelId (0-3)' });
    }
    const level = Number(levelId);

    const user = await getUser(wallet);
    if (!user) return res.status(400).json({ ok: false, error: 'NotRegistered' });
    if (user.active_level !== null) {
      return res.status(400).json({ ok: false, error: 'AlreadyDeposited' });
    }

    const levelCheck = await validateDepositLevel(wallet, level);
    if (!levelCheck.ok) {
      return res.status(400).json({
        ok: false,
        error: levelCheck.error,
        sponsorLevel: levelCheck.sponsorLevel,
        minLevel: levelCheck.sponsorLevel,
        minLevelName: levelCheck.sponsorLevel != null ? LEVEL_NAMES[levelCheck.sponsorLevel] : null,
      });
    }

    // Строим цепочку и payload
    const chain = await buildReferralChain(wallet, level);
    const payload = await buildCascadePayload({ senderWallet: wallet, levelId: level, chain });

    // ── FIX 1: кешируем payload ──────────────────────────────────────────────
    // Ключ = wallet + levelId (один пользователь = один депозит = один уровень)
    const cacheKey = `deposit_payload:${wallet}:${level}`;
    cache.set(cacheKey, {
      instructions: payload.instructions,
      chain,
      levelId: level,
      amountSol: LEVEL_AMOUNTS[level],
      createdAt: Date.now(),
    }, PAYLOAD_TTL);

    logger.info(`Deposit prepared: ${wallet} level=${level} cached=${cacheKey}`);

    res.json({
      ok: true,
      data: {
        levelId: level,
        levelName: LEVEL_NAMES[level],
        amountSol: LEVEL_AMOUNTS[level],
        chain: payload.instructions,
        transactionBase64: payload.transactionBase64,
        // TTL для фронтенда чтобы показать таймер
        expiresIn: PAYLOAD_TTL,
      },
    });
  } catch (e) {
    logger.error('POST /deposit/prepare error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

// ── POST /api/deposit/confirm ─────────────────────────────────────────────────
// Верифицирует транзакцию on-chain и записывает в БД.
// Использует закешированный payload из prepare — не перестраивает цепочку.
registryRouter.post('/deposit/confirm', async (req, res) => {
  try {
    const { wallet, levelId, txSignature } = req.body;
    if (!wallet || levelId === undefined || !txSignature) {
      return res.status(400).json({ ok: false, error: 'wallet, levelId, txSignature required' });
    }
    const level = Number(levelId);

    // ── FIX 1: читаем закешированный payload ─────────────────────────────────
    const cacheKey = `deposit_payload:${wallet}:${level}`;
    const cachedPayload = cache.get<{
      instructions: TransferInstruction[];
      chain: { wallet: string; depth: number; pct: number; amountSol: number }[];
      levelId: number;
      amountSol: number;
      createdAt: number;
    }>(cacheKey);

    if (!cachedPayload) {
      return res.status(400).json({
        ok: false,
        error: 'PrepareExpired',
        message: 'Deposit prepare expired or not found. Please try again.',
      });
    }

    // ── FIX 2: строгая верификация транзакции ─────────────────────────────────
    // Проверяем суммы И адреса получателей, а не только success статус
    const verify = await verifyTransactionStrict({
      txSignature,
      senderWallet: wallet,
      expectedInstructions: cachedPayload.instructions,
    });

    if (!verify.ok) {
      logger.warn(`Transaction verification failed: ${txSignature} error=${verify.error}`);
      return res.status(400).json({ ok: false, error: verify.error });
    }

    // ── FIX 3: race condition защищён в recordDeposit через SELECT FOR UPDATE ─
    const record = await recordDeposit({
      wallet,
      levelId: level,
      amountSol: cachedPayload.amountSol,
      txSignature,
      chain: cachedPayload.chain,
    });

    if (!record.ok) {
      return res.status(400).json({ ok: false, error: record.error });
    }

    // Инвалидируем кеш после успешного депозита
    cache.del(cacheKey);

    logger.info(`Deposit confirmed: ${wallet} level=${level} tx=${txSignature}`);
    res.json({ ok: true, message: 'Deposit confirmed' });

  } catch (e) {
    logger.error('POST /deposit/confirm error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

// ── GET /api/user/:wallet ─────────────────────────────────────────────────────
registryRouter.get('/user/:wallet', async (req, res) => {
  try {
    const user = await getUser(req.params.wallet);
    if (!user) return res.json({ ok: true, data: null });
    res.json({
      ok: true,
      data: {
        wallet: user.wallet,
        referrer: user.referrer,
        activeLevel: user.active_level,
        activeLevelName: user.active_level !== null ? LEVEL_NAMES[user.active_level] : null,
        totalDepositedSol: parseFloat(user.total_deposited),
        totalEarnedSol: parseFloat(user.total_earned),
        totalEarned: parseFloat(user.total_earned),
        referralCount: user.referral_count,
        registeredAt: user.registered_at,
        depositedAt: user.deposited_at,
      },
    });
  } catch (e) {
    logger.error('GET /user error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

// ── GET /api/user/:wallet/referrals ──────────────────────────────────────────
registryRouter.get('/user/:wallet/referrals', async (req, res) => {
  try {
    const referrals = await getUserReferrals(req.params.wallet);
    res.json({
      ok: true,
      data: referrals.map(r => ({
        wallet: r.wallet,
        activeLevel: r.active_level,
        activeLevelName: r.active_level !== null ? LEVEL_NAMES[r.active_level] : null,
        totalDepositedSol: parseFloat(r.total_deposited),
        registeredAt: r.registered_at,
      })),
    });
  } catch (e) {
    logger.error('GET /user/referrals error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
registryRouter.get('/stats', async (_req, res) => {
  try {
    const stats = await getGlobalStats();
    res.json({
      ok: true,
      data: {
        totalDepositedSol: parseFloat(stats.total_deposited),
        totalUsers: stats.total_users,
        totalRefPaidSol: parseFloat(stats.total_ref_paid),
        network: process.env.SOLANA_NETWORK || 'devnet',
        updatedAt: stats.updated_at,
      },
    });
  } catch (e) {
    logger.error('GET /stats error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

// ── GET /api/levels ───────────────────────────────────────────────────────────
registryRouter.get('/levels', async (_req, res) => {
  try {
    const levels = [0, 1, 2, 3].map(id => ({
      id,
      name: LEVEL_NAMES[id],
      amountSol: LEVEL_AMOUNTS[id],
      refPayouts: REF_BPS.map((bps, depth) => ({
        depth,
        pct: bps / 100,
        amountSol: +(LEVEL_AMOUNTS[id] * bps / 10000).toFixed(4),
      })),
    }));
    res.json({ ok: true, data: levels });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});
