/**
 * registry.ts — Регистрация пользователей и управление реферальными цепочками
 *
 * Ключевое правило v6:
 *   deposit_level >= sponsor_level
 *   Если у пользователя нет спонсора — привязывается к project wallet,
 *   правило уровня применяется к уровню project wallet (= 0, т.е. любой уровень доступен)
 */

import { Pool } from 'pg';
import { logger } from './utils/logger';

export const LEVEL_AMOUNTS: Record<number, number> = {
  0: 0.5,   // Starter
  1: 1.0,   // Basic
  2: 3.0,   // Pro
  3: 10.0,  // Elite
};

export const LEVEL_NAMES: Record<number, string> = {
  0: 'Starter',
  1: 'Basic',
  2: 'Pro',
  3: 'Elite',
};

export const REF_BPS = [3000, 2000, 1000, 500]; // 30%, 20%, 10%, 5%
export const MAX_DEPTH = 4;

// ── DB Pool ──────────────────────────────────────────────────────────────────
export let pool: Pool;

export function initDb(connectionString: string) {
  pool = new Pool({ connectionString, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });
  logger.info('PostgreSQL pool initialized');
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface UserRow {
  wallet: string;
  referrer: string | null;
  active_level: number | null;
  total_deposited: string;
  total_earned: string;
  referral_count: number;
  registered_at: Date;
  deposited_at: Date | null;
}

export interface ReferralChain {
  wallet: string;
  depth: number;
  pct: number;
  amountSol: number;
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Регистрирует пользователя.
 * Если referrerWallet не указан — привязывает к PROJECT_WALLET.
 * Если referrerWallet указан — проверяет что реферер зарегистрирован.
 */
export async function registerUser(
  wallet: string,
  referrerWallet?: string | null
): Promise<{ ok: boolean; error?: string; user?: UserRow }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Проверяем не зарегистрирован ли уже
    const existing = await client.query<UserRow>(
      'SELECT * FROM users WHERE wallet = $1',
      [wallet]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'AlreadyRegistered' };
    }

    // Нельзя указывать себя реферером
    if (referrerWallet && referrerWallet === wallet) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'SelfReferral' };
    }

    // Определяем реального спонсора
    const projectWallet = process.env.PROJECT_WALLET!;
    let sponsor = referrerWallet || projectWallet;

    // Если указан реферер — проверяем что он зарегистрирован
    if (referrerWallet) {
      const ref = await client.query<UserRow>(
        'SELECT wallet FROM users WHERE wallet = $1',
        [referrerWallet]
      );
      if (ref.rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'ReferrerNotRegistered' };
      }
    } else {
      // Нет реферера — project wallet как спонсор
      // Project wallet не обязан быть в таблице users (он оператор)
      sponsor = projectWallet;
    }

    // Создаём пользователя
    const result = await client.query<UserRow>(
      `INSERT INTO users (wallet, referrer)
       VALUES ($1, $2)
       RETURNING *`,
      [wallet, sponsor]
    );

    // Обновляем счётчик рефералов у спонсора (только если спонсор есть в таблице)
    if (referrerWallet) {
      await client.query(
        'UPDATE users SET referral_count = referral_count + 1 WHERE wallet = $1',
        [referrerWallet]
      );
    }

    // Обновляем total_users в global_stats
    await client.query(
      'UPDATE global_stats SET total_users = total_users + 1, updated_at = NOW() WHERE id = 1'
    );

    await client.query('COMMIT');
    logger.info(`User registered: ${wallet} → sponsor: ${sponsor}`);
    return { ok: true, user: result.rows[0] };

  } catch (e) {
    await client.query('ROLLBACK');
    logger.error('registerUser error', e);
    return { ok: false, error: 'InternalError' };
  } finally {
    client.release();
  }
}

// ── Level validation ─────────────────────────────────────────────────────────

/**
 * Проверяет что depositLevel >= уровня спонсора.
 * Ключевое правило v6.
 */
export async function validateDepositLevel(
  wallet: string,
  depositLevel: number
): Promise<{ ok: boolean; error?: string; sponsorLevel?: number | null }> {
  // Получаем спонсора пользователя
  const userResult = await pool.query<UserRow>(
    'SELECT referrer FROM users WHERE wallet = $1',
    [wallet]
  );

  if (userResult.rows.length === 0) {
    return { ok: false, error: 'NotRegistered' };
  }

  const referrer = userResult.rows[0].referrer;

  // Если спонсор = project wallet или null → нет ограничения по уровню
  const projectWallet = process.env.PROJECT_WALLET!;
  if (!referrer || referrer === projectWallet) {
    return { ok: true, sponsorLevel: null };
  }

  // Получаем уровень спонсора
  const sponsorResult = await pool.query<UserRow>(
    'SELECT active_level FROM users WHERE wallet = $1',
    [referrer]
  );

  if (sponsorResult.rows.length === 0) {
    return { ok: true, sponsorLevel: null }; // спонсор не найден — нет ограничения
  }

  const sponsorLevel = sponsorResult.rows[0].active_level;

  // Если спонсор ещё не сделал депозит — нет ограничения
  if (sponsorLevel === null || sponsorLevel === undefined) {
    return { ok: true, sponsorLevel: null };
  }

  // Главное правило: depositLevel >= sponsorLevel
  if (depositLevel < sponsorLevel) {
    return {
      ok: false,
      error: 'LevelBelowSponsor',
      sponsorLevel,
    };
  }

  return { ok: true, sponsorLevel };
}

// ── Referral chain ───────────────────────────────────────────────────────────

/**
 * Строит реферальную цепочку для выплат.
 * Возвращает массив до 4 получателей с суммами.
 */
export async function buildReferralChain(
  wallet: string,
  depositLevel: number
): Promise<ReferralChain[]> {
  const amountSol = LEVEL_AMOUNTS[depositLevel];
  const chain: ReferralChain[] = [];

  // Получаем спонсора
  const userResult = await pool.query<UserRow>(
    'SELECT referrer FROM users WHERE wallet = $1',
    [wallet]
  );

  if (userResult.rows.length === 0) return chain;

  let currentWallet = userResult.rows[0].referrer;
  const projectWallet = process.env.PROJECT_WALLET!;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!currentWallet) break;

    const pct = REF_BPS[depth] / 100; // в процентах
    const amountForDepth = (amountSol * REF_BPS[depth]) / 10000;

    chain.push({
      wallet: currentWallet,
      depth,
      pct: REF_BPS[depth] / 100,
      amountSol: amountForDepth,
    });

    // Если дошли до project wallet — останавливаемся
    if (currentWallet === projectWallet) break;

    // Идём вверх по цепочке
    const nextResult = await pool.query<UserRow>(
      'SELECT referrer FROM users WHERE wallet = $1',
      [currentWallet]
    );

    if (nextResult.rows.length === 0) break;
    currentWallet = nextResult.rows[0].referrer;
  }

  return chain;
}

// ── Deposit record ───────────────────────────────────────────────────────────

/**
 * Записывает депозит и реф. выплаты в БД после подтверждения транзакции.
 */
export async function recordDeposit(params: {
  wallet: string;
  levelId: number;
  amountSol: number;
  txSignature: string;
  chain: ReferralChain[];
}): Promise<{ ok: boolean; error?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── FIX 3: SELECT FOR UPDATE — защита от race condition ─────────────────
    // Блокируем строку пользователя на время транзакции.
    // Если два запроса придут одновременно — второй будет ждать.
    const userResult = await client.query<UserRow>(
      'SELECT active_level FROM users WHERE wallet = $1 FOR UPDATE',
      [params.wallet]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'NotRegistered' };
    }

    if (userResult.rows[0].active_level !== null) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'AlreadyDeposited' };
    }

    // Записываем депозит
    const depositResult = await client.query(
      `INSERT INTO deposits (wallet, level_id, amount_sol, tx_signature, tx_confirmed, confirmed_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       RETURNING id`,
      [params.wallet, params.levelId, params.amountSol, params.txSignature]
    );
    const depositId = depositResult.rows[0].id;

    // Записываем реф. выплаты
    for (const ref of params.chain) {
      await client.query(
        `INSERT INTO referral_payouts (deposit_id, recipient, depth, pct, amount_sol)
         VALUES ($1, $2, $3, $4, $5)`,
        [depositId, ref.wallet, ref.depth, ref.pct, ref.amountSol]
      );
      // Обновляем total_earned у получателя (если он в таблице users)
      await client.query(
        `UPDATE users SET total_earned = total_earned + $1 WHERE wallet = $2`,
        [ref.amountSol, ref.wallet]
      );
    }

    // Обновляем пользователя
    await client.query(
      `UPDATE users SET
         active_level    = $1,
         total_deposited = total_deposited + $2,
         deposited_at    = NOW()
       WHERE wallet = $3`,
      [params.levelId, params.amountSol, params.wallet]
    );

    // Обновляем global_stats
    const refPaid = params.chain.reduce((s, r) => s + r.amountSol, 0);
    await client.query(
      `UPDATE global_stats SET
         total_deposited = total_deposited + $1,
         total_ref_paid  = total_ref_paid  + $2,
         updated_at      = NOW()
       WHERE id = 1`,
      [params.amountSol, refPaid]
    );

    await client.query('COMMIT');
    logger.info(`Deposit recorded: ${params.wallet} level=${params.levelId} tx=${params.txSignature}`);
    return { ok: true };

  } catch (e) {
    await client.query('ROLLBACK');
    logger.error('recordDeposit error', e);
    return { ok: false, error: 'InternalError' };
  } finally {
    client.release();
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function getUser(wallet: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    'SELECT * FROM users WHERE wallet = $1',
    [wallet]
  );
  return result.rows[0] || null;
}

export async function getUserReferrals(wallet: string): Promise<UserRow[]> {
  const result = await pool.query<UserRow>(
    'SELECT * FROM users WHERE referrer = $1 ORDER BY registered_at DESC',
    [wallet]
  );
  return result.rows;
}

export async function getGlobalStats() {
  const result = await pool.query(
    'SELECT * FROM global_stats WHERE id = 1'
  );
  return result.rows[0];
}
