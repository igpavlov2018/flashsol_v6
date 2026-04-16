/**
 * scripts/migrate.js — Миграция с централизованного бэкенда на смарт-контракт
 *
 * СТАТУС: ЗАГОТОВКА (Phase 2)
 *
 * Когда использовать:
 *   После деплоя смарт-контракта FlashSol на mainnet запустить этот скрипт
 *   чтобы воссоздать все реферальные цепочки on-chain.
 *
 * Что делает:
 *   1. Читает всех пользователей из PostgreSQL
 *   2. Для каждого создаёт on-chain PDA через инструкцию `register`
 *   3. Для пользователей с депозитом — устанавливает active_level
 *
 * Порядок миграции (ВАЖНО):
 *   - Сначала мигрировать пользователей без реферера (корневые)
 *   - Затем по уровням вглубь дерева (BFS)
 *   - Это гарантирует что реферер уже существует on-chain когда регистрируется реферал
 *
 * Использование:
 *   DATABASE_URL=... PROGRAM_ID=... RPC_URL=... ADMIN_KEYPAIR=... node scripts/migrate.js
 */

import pg from 'pg';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
} from '@solana/web3.js';
import fs from 'fs';

const { Pool } = pg;

// ── Config ───────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const PROGRAM_ID   = process.env.PROGRAM_ID;
const RPC_URL      = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const KEYPAIR_PATH = process.env.ADMIN_KEYPAIR || './admin-keypair.json';

if (!DATABASE_URL || !PROGRAM_ID) {
  console.error('Required: DATABASE_URL, PROGRAM_ID');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const connection = new Connection(RPC_URL, 'confirmed');

// ── Main ─────────────────────────────────────────────────────────────────────
async function migrate() {
  console.log('🚀 FlashSol v6 → Smart Contract Migration');
  console.log('==========================================');
  console.log(`Program ID: ${PROGRAM_ID}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log('');

  // TODO Phase 2: раскомментировать после деплоя смарт-контракта
  /*
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  // 1. Получаем всех пользователей упорядоченных BFS (корни первыми)
  const users = await pool.query(`
    WITH RECURSIVE tree AS (
      -- Корневые пользователи (без реферера или реферер = project wallet)
      SELECT wallet, referrer, active_level, 0 AS depth
      FROM users
      WHERE referrer IS NULL OR referrer = $1

      UNION ALL

      -- Рефералы
      SELECT u.wallet, u.referrer, u.active_level, t.depth + 1
      FROM users u
      JOIN tree t ON u.referrer = t.wallet
    )
    SELECT * FROM tree ORDER BY depth, wallet
  `, [process.env.PROJECT_WALLET]);

  console.log(`Found ${users.rows.length} users to migrate`);

  let success = 0, failed = 0;

  for (const user of users.rows) {
    try {
      // Здесь будет вызов register + deposit инструкций смарт-контракта
      // await registerOnChain(payer, user.wallet, user.referrer, connection, PROGRAM_ID);
      // if (user.active_level !== null) {
      //   await depositOnChain(payer, user.wallet, user.active_level, connection, PROGRAM_ID);
      // }
      success++;
      if (success % 10 === 0) console.log(`  Migrated ${success}/${users.rows.length}...`);
    } catch (e) {
      failed++;
      console.error(`  ❌ Failed: ${user.wallet}`, e.message);
    }
  }

  console.log('');
  console.log(`✅ Migration complete: ${success} success, ${failed} failed`);
  */

  // ── Dry run (Phase 1) ─────────────────────────────────────────────────────
  const stats = await pool.query('SELECT * FROM global_stats WHERE id = 1');
  const users = await pool.query('SELECT COUNT(*) as cnt FROM users');
  const withDeposit = await pool.query('SELECT COUNT(*) as cnt FROM users WHERE active_level IS NOT NULL');

  console.log('📊 Current DB state (dry run):');
  console.log(`   Total users:        ${users.rows[0].cnt}`);
  console.log(`   With deposits:      ${withDeposit.rows[0].cnt}`);
  console.log(`   Total deposited:    ${stats.rows[0].total_deposited} SOL`);
  console.log(`   Total ref paid:     ${stats.rows[0].total_ref_paid} SOL`);
  console.log('');
  console.log('⏳ Migration script ready — will execute after smart contract deployment');
  console.log('   Uncomment the migration code above and run again with PROGRAM_ID set');

  await pool.end();
}

migrate().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
