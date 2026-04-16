/**
 * cascade.ts — Построитель multi-transfer транзакции
 *
 * Заменяет смарт-контракт на фазе 1.
 * Формирует одну транзакцию с несколькими SystemProgram.transfer инструкциями:
 *   - до 4 рефереров (30% / 20% / 10% / 5%)
 *   - остаток → project wallet
 *
 * Пользователь подписывает ОДНУ транзакцию в Phantom.
 * Все выплаты происходят атомарно on-chain.
 * Бэкенд участвует только ДО подписи (вычисляет цепочку).
 * После подписи бэкенд только записывает факт в БД.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { ReferralChain, LEVEL_AMOUNTS } from './registry';
import { logger } from './utils/logger';

// ── Connection ───────────────────────────────────────────────────────────────
export const connection = new Connection(
  process.env.RPC_URL || 'https://api.devnet.solana.com',
  { commitment: 'confirmed' }
);

// ── Types ────────────────────────────────────────────────────────────────────
export interface TransferInstruction {
  recipient: string;
  amountSol: number;
  amountLamports: number;
  role: 'referrer' | 'project';
  depth?: number;
  pct?: number;
}

export interface CascadePayload {
  instructions: TransferInstruction[];
  totalSol: number;
  totalLamports: number;
  levelId: number;
  // Serialized transaction (base64) для подписи в Phantom
  transactionBase64: string;
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Строит payload для фронтенда.
 * Фронтенд десериализует транзакцию, подписывает и отправляет.
 */
export async function buildCascadePayload(params: {
  senderWallet: string;
  levelId: number;
  chain: ReferralChain[];
}): Promise<CascadePayload> {
  const { senderWallet, levelId, chain } = params;
  const amountSol = LEVEL_AMOUNTS[levelId];
  const totalLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const projectWallet = process.env.PROJECT_WALLET!;

  const instructions: TransferInstruction[] = [];
  let refPaidLamports = 0;

  // Инструкции для рефереров
  for (const ref of chain) {
    const lamports = Math.round(ref.amountSol * LAMPORTS_PER_SOL);
    instructions.push({
      recipient: ref.wallet,
      amountSol: ref.amountSol,
      amountLamports: lamports,
      role: 'referrer',
      depth: ref.depth,
      pct: ref.pct,
    });
    refPaidLamports += lamports;
  }

  // Остаток → project wallet
  const projectLamports = totalLamports - refPaidLamports;
  instructions.push({
    recipient: projectWallet,
    amountSol: projectLamports / LAMPORTS_PER_SOL,
    amountLamports: projectLamports,
    role: 'project',
  });

  // Строим транзакцию
  const tx = await buildTransaction(senderWallet, instructions);
  const serialized = tx.serialize({ requireAllSignatures: false });
  const transactionBase64 = Buffer.from(serialized).toString('base64');

  logger.info(
    `CascadePayload built: sender=${senderWallet} level=${levelId} ` +
    `refs=${chain.length} total=${amountSol} SOL`
  );

  return {
    instructions,
    totalSol: amountSol,
    totalLamports,
    levelId,
    transactionBase64,
  };
}

/**
 * Строит Transaction с несколькими transfer инструкциями.
 */
async function buildTransaction(
  senderWallet: string,
  instructions: TransferInstruction[]
): Promise<Transaction> {
  const sender = new PublicKey(senderWallet);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: sender,
  });

  for (const instr of instructions) {
    // Дедупликация: если sender совпадает с recipient — пропускаем
    // (может случиться если пользователь = project wallet)
    if (instr.recipient === senderWallet) continue;
    if (instr.amountLamports <= 0) continue;

    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: new PublicKey(instr.recipient),
        lamports: instr.amountLamports,
      })
    );
  }

  return tx;
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * @deprecated Используй verifyTransactionStrict
 */
export async function verifyTransaction(params: {
  txSignature: string;
  senderWallet: string;
  expectedInstructions: TransferInstruction[];
}): Promise<{ ok: boolean; error?: string }> {
  return verifyTransactionStrict(params);
}

/**
 * FIX 2: Строгая верификация — проверяет суммы И адреса получателей on-chain.
 */
export async function verifyTransactionStrict(params: {
  txSignature: string;
  senderWallet: string;
  expectedInstructions: TransferInstruction[];
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { txSignature, senderWallet, expectedInstructions } = params;

    const result = await connection.confirmTransaction(txSignature, 'confirmed');
    if (result.value.err) return { ok: false, error: 'TransactionFailed' };

    const txDetail = await connection.getParsedTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!txDetail) return { ok: false, error: 'TransactionNotFound' };
    if (txDetail.meta?.err) return { ok: false, error: 'TransactionError' };

    // Fee payer = sender
    const feePayer = txDetail.transaction.message.accountKeys[0];
    if (feePayer.pubkey.toString() !== senderWallet) {
      return { ok: false, error: 'InvalidSender' };
    }

    // Строим карту реальных изменений балансов
    const preBalances  = txDetail.meta?.preBalances  || [];
    const postBalances = txDetail.meta?.postBalances || [];
    const accountKeys  = txDetail.transaction.message.accountKeys.map(k => k.pubkey.toString());

    const actualReceipts = new Map<string, number>();
    for (let i = 0; i < accountKeys.length; i++) {
      const delta = (postBalances[i] || 0) - (preBalances[i] || 0);
      if (delta > 0 && accountKeys[i] !== senderWallet) {
        actualReceipts.set(accountKeys[i], (actualReceipts.get(accountKeys[i]) || 0) + delta);
      }
    }

    // Сверяем каждый ожидаемый перевод (допуск ±1000 лампортов)
    const TOLERANCE = 1000;
    for (const instr of expectedInstructions) {
      if (instr.recipient === senderWallet) continue;
      const actualLamports = actualReceipts.get(instr.recipient) || 0;
      if (Math.abs(actualLamports - instr.amountLamports) > TOLERANCE) {
        logger.warn(`Strict verify failed: recipient=${instr.recipient} expected=${instr.amountLamports} actual=${actualLamports} tx=${txSignature}`);
        return { ok: false, error: 'InvalidTransferAmount' };
      }
    }

    logger.info(`Transaction strictly verified: ${txSignature}`);
    return { ok: true };

  } catch (e) {
    logger.error('verifyTransactionStrict error', e);
    return { ok: false, error: 'VerificationFailed' };
  }
}
