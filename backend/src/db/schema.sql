-- ============================================================
-- FlashSol v6 — PostgreSQL Schema
-- Централизованный бэкенд (фаза 1 перед смарт-контрактом)
-- Структура зеркалит UserAccount из lib.rs для безболезненной миграции
-- ============================================================

-- Расширения
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Пользователи ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  -- Solana wallet address (base58) — PRIMARY KEY
  wallet          VARCHAR(44)  PRIMARY KEY,

  -- Реферер (wallet address спонсора, NULL если пришёл без ссылки)
  referrer        VARCHAR(44)  REFERENCES users(wallet) ON DELETE SET NULL,

  -- Уровень депозита: 0=Starter, 1=Basic, 2=Pro, 3=Elite, NULL=не сделал депозит
  active_level    SMALLINT     CHECK (active_level BETWEEN 0 AND 3),

  -- Статистика (зеркалит on-chain поля для будущей миграции)
  total_deposited NUMERIC(20,9) NOT NULL DEFAULT 0,  -- SOL
  total_earned    NUMERIC(20,9) NOT NULL DEFAULT 0,  -- SOL (реф. выплаты)
  referral_count  INTEGER      NOT NULL DEFAULT 0,

  -- Мета
  registered_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deposited_at    TIMESTAMPTZ,

  -- Индекс для быстрого поиска по реферальной цепочке
  CONSTRAINT chk_no_self_referral CHECK (wallet <> referrer)
);

-- ── Депозиты ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposits (
  id              BIGSERIAL    PRIMARY KEY,
  wallet          VARCHAR(44)  NOT NULL REFERENCES users(wallet),
  level_id        SMALLINT     NOT NULL CHECK (level_id BETWEEN 0 AND 3),
  amount_sol      NUMERIC(20,9) NOT NULL,

  -- Solana tx signature — доказательство on-chain
  tx_signature    VARCHAR(88)  UNIQUE,
  tx_confirmed    BOOLEAN      NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ
);

-- ── Реферальные выплаты ───────────────────────────────────────
-- Каждая строка = одна выплата рефереру в рамках депозита
CREATE TABLE IF NOT EXISTS referral_payouts (
  id              BIGSERIAL    PRIMARY KEY,
  deposit_id      BIGINT       NOT NULL REFERENCES deposits(id),
  recipient       VARCHAR(44)  NOT NULL,  -- wallet реферера
  depth           SMALLINT     NOT NULL CHECK (depth BETWEEN 0 AND 3),  -- 0=прямой, 1,2,3
  pct             SMALLINT     NOT NULL,  -- 30, 20, 10, 5
  amount_sol      NUMERIC(20,9) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Индексы ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_referrer       ON users(referrer);
CREATE INDEX IF NOT EXISTS idx_deposits_wallet      ON deposits(wallet);
CREATE INDEX IF NOT EXISTS idx_deposits_created     ON deposits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_recipient    ON referral_payouts(recipient);
CREATE INDEX IF NOT EXISTS idx_payouts_deposit      ON referral_payouts(deposit_id);

-- ── Глобальная статистика (materialized view) ─────────────────
-- Обновляется триггером при каждом подтверждённом депозите
CREATE TABLE IF NOT EXISTS global_stats (
  id              INTEGER      PRIMARY KEY DEFAULT 1,
  total_deposited NUMERIC(20,9) NOT NULL DEFAULT 0,
  total_users     INTEGER      NOT NULL DEFAULT 0,
  total_ref_paid  NUMERIC(20,9) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO global_stats (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── Триггер обновления глобальной статистики ──────────────────
CREATE OR REPLACE FUNCTION update_global_stats() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tx_confirmed = TRUE AND (OLD.tx_confirmed = FALSE OR OLD.tx_confirmed IS NULL) THEN
    UPDATE global_stats SET
      total_deposited = total_deposited + NEW.amount_sol,
      updated_at = NOW()
    WHERE id = 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_deposit_confirmed
  AFTER UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION update_global_stats();

-- ── Комментарии для миграции ──────────────────────────────────
COMMENT ON TABLE users IS 'Зеркало UserAccount из смарт-контракта. При миграции: каждая строка → on-chain PDA через initialize_user';
COMMENT ON TABLE deposits IS 'История депозитов. При миграции: последний депозит определяет active_level on-chain';
COMMENT ON TABLE referral_payouts IS 'Лог реф. выплат для аудита и будущей верификации on-chain';
