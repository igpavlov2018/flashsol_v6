/**
 * __tests__/routes.test.ts
 * Интеграционные тесты API — мокируем БД и Solana
 */

import request from 'supertest';
import express from 'express';
import { registryRouter } from '../routes/registry';

// Мокируем registry модуль
jest.mock('../registry', () => ({
  LEVEL_AMOUNTS: { 0: 0.5, 1: 1.0, 2: 3.0, 3: 10.0 },
  LEVEL_NAMES: { 0: 'Starter', 1: 'Basic', 2: 'Pro', 3: 'Elite' },
  REF_BPS: [3000, 2000, 1000, 500],
  MAX_DEPTH: 4,
  getUser: jest.fn(),
  registerUser: jest.fn(),
  validateDepositLevel: jest.fn(),
  buildReferralChain: jest.fn(),
  recordDeposit: jest.fn(),
  getUserReferrals: jest.fn(),
  getGlobalStats: jest.fn(),
  pool: { query: jest.fn() },
}));

// Мокируем cascade модуль
jest.mock('../cascade', () => ({
  buildCascadePayload: jest.fn(),
  verifyTransactionStrict: jest.fn(),
}));

// Мокируем cache
jest.mock('../utils/cache', () => ({
  cache: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    clear: jest.fn(),
  },
}));

import * as registry from '../registry';
import * as cascade from '../cascade';
import { cache } from '../utils/cache';

const app = express();
app.use(express.json());
app.use('/api', registryRouter);

const WALLET_A = '7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012';
const WALLET_B = '9mQpBCDEFGHIJKLMNOPQRSTUVWXYZ123456789012';

beforeEach(() => jest.clearAllMocks());

// ── /register ─────────────────────────────────────────────────────────────────
describe('POST /api/register', () => {
  test('returns 400 without wallet', async () => {
    const res = await request(app).post('/api/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('registers new user successfully', async () => {
    (registry.registerUser as jest.Mock).mockResolvedValue({
      ok: true,
      user: { wallet: WALLET_A, referrer: null, active_level: null },
    });
    const res = await request(app).post('/api/register').send({ wallet: WALLET_A });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns error for duplicate registration', async () => {
    (registry.registerUser as jest.Mock).mockResolvedValue({
      ok: false, error: 'AlreadyRegistered',
    });
    const res = await request(app).post('/api/register').send({ wallet: WALLET_A });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('AlreadyRegistered');
  });
});

// ── /deposit/prepare ─────────────────────────────────────────────────────────
describe('POST /api/deposit/prepare', () => {
  test('returns 400 for invalid levelId', async () => {
    const res = await request(app).post('/api/deposit/prepare').send({ wallet: WALLET_A, levelId: 99 });
    expect(res.status).toBe(400);
  });

  test('returns 400 if user not registered', async () => {
    (registry.getUser as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post('/api/deposit/prepare').send({ wallet: WALLET_A, levelId: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NotRegistered');
  });

  test('returns 400 if already deposited', async () => {
    (registry.getUser as jest.Mock).mockResolvedValue({ wallet: WALLET_A, active_level: 0 });
    const res = await request(app).post('/api/deposit/prepare').send({ wallet: WALLET_A, levelId: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('AlreadyDeposited');
  });

  test('returns LevelBelowSponsor when level too low', async () => {
    (registry.getUser as jest.Mock).mockResolvedValue({ wallet: WALLET_B, active_level: null });
    (registry.validateDepositLevel as jest.Mock).mockResolvedValue({
      ok: false, error: 'LevelBelowSponsor', sponsorLevel: 3,
    });
    const res = await request(app).post('/api/deposit/prepare').send({ wallet: WALLET_B, levelId: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LevelBelowSponsor');
    expect(res.body.minLevel).toBe(3);
  });

  test('returns prepared transaction for valid request', async () => {
    (registry.getUser as jest.Mock).mockResolvedValue({ wallet: WALLET_A, active_level: null });
    (registry.validateDepositLevel as jest.Mock).mockResolvedValue({ ok: true, sponsorLevel: null });
    (registry.buildReferralChain as jest.Mock).mockResolvedValue([]);
    (cascade.buildCascadePayload as jest.Mock).mockResolvedValue({
      instructions: [],
      totalSol: 0.5,
      totalLamports: 500000000,
      levelId: 0,
      transactionBase64: 'base64tx==',
    });
    (cache.set as jest.Mock).mockReturnValue(undefined);

    const res = await request(app).post('/api/deposit/prepare').send({ wallet: WALLET_A, levelId: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.transactionBase64).toBe('base64tx==');
    expect(res.body.data.expiresIn).toBe(600);
    // Проверяем что payload закеширован
    expect(cache.set).toHaveBeenCalledWith(
      `deposit_payload:${WALLET_A}:0`,
      expect.any(Object),
      600
    );
  });
});

// ── /deposit/confirm ─────────────────────────────────────────────────────────
describe('POST /api/deposit/confirm', () => {
  test('returns PrepareExpired when cache miss', async () => {
    (cache.get as jest.Mock).mockReturnValue(null);
    const res = await request(app).post('/api/deposit/confirm').send({
      wallet: WALLET_A, levelId: 0, txSignature: 'sig123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PrepareExpired');
  });

  test('returns error when strict verification fails', async () => {
    (cache.get as jest.Mock).mockReturnValue({
      instructions: [{ recipient: 'project', amountLamports: 175000000, role: 'project' }],
      chain: [],
      levelId: 0,
      amountSol: 0.5,
      createdAt: Date.now(),
    });
    (cascade.verifyTransactionStrict as jest.Mock).mockResolvedValue({
      ok: false, error: 'InvalidTransferAmount',
    });

    const res = await request(app).post('/api/deposit/confirm').send({
      wallet: WALLET_A, levelId: 0, txSignature: 'bad_sig',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidTransferAmount');
  });

  test('confirms deposit successfully', async () => {
    (cache.get as jest.Mock).mockReturnValue({
      instructions: [],
      chain: [],
      levelId: 0,
      amountSol: 0.5,
      createdAt: Date.now(),
    });
    (cascade.verifyTransactionStrict as jest.Mock).mockResolvedValue({ ok: true });
    (registry.recordDeposit as jest.Mock).mockResolvedValue({ ok: true });
    (cache.del as jest.Mock).mockReturnValue(undefined);

    const res = await request(app).post('/api/deposit/confirm').send({
      wallet: WALLET_A, levelId: 0, txSignature: 'valid_sig',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Кеш должен быть очищен после успеха
    expect(cache.del).toHaveBeenCalledWith(`deposit_payload:${WALLET_A}:0`);
  });
});

// ── /stats ────────────────────────────────────────────────────────────────────
describe('GET /api/stats', () => {
  test('returns stats', async () => {
    (registry.getGlobalStats as jest.Mock).mockResolvedValue({
      total_deposited: '150.5',
      total_users: 42,
      total_ref_paid: '55.2',
      updated_at: new Date(),
    });
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totalUsers).toBe(42);
  });
});
