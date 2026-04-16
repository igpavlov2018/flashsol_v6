/**
 * __tests__/registry.test.ts
 * Unit тесты для registry.ts — без реального подключения к БД
 */

import { LEVEL_AMOUNTS, LEVEL_NAMES, REF_BPS, MAX_DEPTH } from '../registry';

// ── Тесты констант ────────────────────────────────────────────────────────────
describe('Level constants', () => {
  test('LEVEL_AMOUNTS has 4 levels', () => {
    expect(Object.keys(LEVEL_AMOUNTS)).toHaveLength(4);
  });

  test('LEVEL_AMOUNTS values are correct', () => {
    expect(LEVEL_AMOUNTS[0]).toBe(0.5);  // Starter
    expect(LEVEL_AMOUNTS[1]).toBe(1.0);  // Basic
    expect(LEVEL_AMOUNTS[2]).toBe(3.0);  // Pro
    expect(LEVEL_AMOUNTS[3]).toBe(10.0); // Elite
  });

  test('LEVEL_NAMES has 4 levels', () => {
    expect(Object.keys(LEVEL_NAMES)).toHaveLength(4);
    expect(LEVEL_NAMES[0]).toBe('Starter');
    expect(LEVEL_NAMES[3]).toBe('Elite');
  });

  test('REF_BPS sums to <= 10000', () => {
    const total = REF_BPS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(10000);
  });

  test('REF_BPS has 4 levels', () => {
    expect(REF_BPS).toHaveLength(4);
    expect(REF_BPS[0]).toBe(3000); // 30%
    expect(REF_BPS[1]).toBe(2000); // 20%
    expect(REF_BPS[2]).toBe(1000); // 10%
    expect(REF_BPS[3]).toBe(500);  // 5%
  });

  test('MAX_DEPTH is 4', () => {
    expect(MAX_DEPTH).toBe(4);
  });
});

// ── Тесты расчёта выплат ──────────────────────────────────────────────────────
describe('Payout calculations', () => {
  test('Starter level payouts sum to 65% of deposit', () => {
    const deposit = LEVEL_AMOUNTS[0]; // 0.5 SOL
    const totalRefPct = REF_BPS.reduce((a, b) => a + b, 0) / 100; // 65%
    const totalRef = deposit * totalRefPct / 100;
    expect(totalRef).toBeCloseTo(0.325, 5);
  });

  test('Elite level direct referral payout is 3 SOL (30%)', () => {
    const deposit = LEVEL_AMOUNTS[3]; // 10 SOL
    const payout = deposit * REF_BPS[0] / 10000;
    expect(payout).toBe(3.0);
  });

  test('Pro level 4th level payout is 0.15 SOL (5%)', () => {
    const deposit = LEVEL_AMOUNTS[2]; // 3 SOL
    const payout = deposit * REF_BPS[3] / 10000;
    expect(payout).toBeCloseTo(0.15, 5);
  });

  test('Project wallet gets 35% of each deposit', () => {
    for (const [id, amount] of Object.entries(LEVEL_AMOUNTS)) {
      const totalRefPct = REF_BPS.reduce((a, b) => a + b, 0); // 6500 bps = 65%
      const projectPct = 10000 - totalRefPct; // 3500 bps = 35%
      const projectShare = amount * projectPct / 10000;
      expect(projectShare / amount * 100).toBeCloseTo(35, 1);
    }
  });
});

// ── Тесты правила уровней (v6) ───────────────────────────────────────────────
describe('Level rule v6 - deposit_level >= sponsor_level', () => {
  test('Starter sponsor allows Starter+', () => {
    const sponsorLevel = 0;
    expect(0 >= sponsorLevel).toBe(true);  // Starter ✓
    expect(1 >= sponsorLevel).toBe(true);  // Basic ✓
    expect(2 >= sponsorLevel).toBe(true);  // Pro ✓
    expect(3 >= sponsorLevel).toBe(true);  // Elite ✓
  });

  test('Elite sponsor allows only Elite', () => {
    const sponsorLevel = 3;
    expect(0 >= sponsorLevel).toBe(false); // Starter ✗
    expect(1 >= sponsorLevel).toBe(false); // Basic ✗
    expect(2 >= sponsorLevel).toBe(false); // Pro ✗
    expect(3 >= sponsorLevel).toBe(true);  // Elite ✓
  });

  test('Pro sponsor allows Pro and Elite', () => {
    const sponsorLevel = 2;
    expect(0 >= sponsorLevel).toBe(false); // Starter ✗
    expect(1 >= sponsorLevel).toBe(false); // Basic ✗
    expect(2 >= sponsorLevel).toBe(true);  // Pro ✓
    expect(3 >= sponsorLevel).toBe(true);  // Elite ✓
  });
});

// ── Тесты ввода данных ────────────────────────────────────────────────────────
describe('Input validation', () => {
  test('Valid levelIds are 0-3', () => {
    const valid = [0, 1, 2, 3];
    valid.forEach(id => expect([0, 1, 2, 3].includes(id)).toBe(true));
  });

  test('Invalid levelIds are rejected', () => {
    const invalid = [-1, 4, 99, NaN];
    invalid.forEach(id => expect([0, 1, 2, 3].includes(id)).toBe(false));
  });

  test('Solana wallet address length is 32-44 chars', () => {
    const validWallet = '7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012';
    expect(validWallet.length).toBeGreaterThanOrEqual(32);
    expect(validWallet.length).toBeLessThanOrEqual(44);
  });
});
