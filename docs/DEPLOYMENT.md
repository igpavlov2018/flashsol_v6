# FlashSol v6 — Руководство по развёртыванию

> Версия 6.0 • Апрель 2026

## Карта этапов

| Этап | Инфраструктура | Цена |
|------|---------------|------|
| [Этап 1 — Бесплатный старт](#этап-1--бесплатный-старт) | Railway + Supabase + GitHub Pages | 0 $/мес |
| [Этап 2 — Платный базовый](#этап-2--платный-базовый) | Hetzner VPS + Supabase | 5–10 $/мес |
| [Этап 3 — Полная автономия + Смарт-контракт](#этап-3--полная-автономия--смарт-контракт) | VPS + Docker + PostgreSQL + Anchor | 10–20 $/мес |

---

## 1. Обзор архитектуры

FlashSol v6 — централизованный бэкенд, заменяющий смарт-контракт на Фазе 1. Пользователь подписывает одну транзакцию в Phantom, которая атомарно распределяет SOL между реферерами и проектом on-chain. Бэкенд участвует только до подписи — строит транзакцию и верифицирует её после отправки.

### Стек

| Компонент | Технология | Назначение |
|-----------|-----------|-----------|
| Backend API | Express + TypeScript | Регистрация, построение и верификация транзакций |
| База данных | PostgreSQL 16 | Пользователи, депозиты, реф. выплаты, статистика |
| Кеш | In-memory / Redis | Payload между prepare и confirm (TTL 10 мин) |
| Frontend | Vanilla HTML/JS | UI, интеграция с Phantom |
| Blockchain | Solana Web3.js | Построение и верификация транзакций on-chain |

### Реферальные выплаты

| Получатель | Starter 0.5 SOL | Basic 1 SOL | Pro 3 SOL | Elite 10 SOL |
|-----------|----------------|------------|----------|-------------|
| Реферер 1 (30%) | 0.15 SOL | 0.30 SOL | 0.90 SOL | 3.00 SOL |
| Реферер 2 (20%) | 0.10 SOL | 0.20 SOL | 0.60 SOL | 2.00 SOL |
| Реферер 3 (10%) | 0.05 SOL | 0.10 SOL | 0.30 SOL | 1.00 SOL |
| Реферер 4  (5%) | 0.025 SOL | 0.05 SOL | 0.15 SOL | 0.50 SOL |
| **Проект (35%)** | **0.175 SOL** | **0.35 SOL** | **1.05 SOL** | **3.50 SOL** |

---

## 2. Требования и переменные окружения

### Необходимое ПО

| ПО | Версия | Проверка |
|----|--------|---------|
| Docker + Compose | 24+ / 2.x | `docker --version && docker compose version` |
| Node.js | 20+ | `node --version` |
| Git | любая | `git --version` |
| Phantom Wallet | браузерное расш. | [phantom.app](https://phantom.app) |

### Переменные окружения (`.env`)

| Переменная | Обязат. | Описание |
|-----------|---------|---------|
| `DATABASE_URL` | да | Строка подключения PostgreSQL |
| `PROJECT_WALLET` | да | Solana-адрес кошелька проекта (base58) |
| `SOLANA_NETWORK` | да | `devnet` или `mainnet-beta` |
| `ADMIN_SECRET` | да | Секрет для `/api/admin` (мин. 32 символа) |
| `FRONTEND_URL` | prod | URL фронтенда для CORS |
| `RPC_URL` | нет | URL Solana RPC. По умолчанию — публичная нода |
| `PORT` | нет | Порт бэкенда. По умолчанию: 3001 |
| `DB_SSL` | нет | `true` для облачных БД с SSL |
| `REDIS_URL` | нет | При наличии — кеш переключается на Redis |

---

## 3. Тестирование на Devnet (GitHub Codespaces)

> **Рекомендуется GitHub Codespaces** — готовый Linux-контейнер с Docker, без локальных конфликтов зависимостей.

### Открыть Codespace

1. Открыть репозиторий на GitHub
2. Нажать **Code → Codespaces → Create codespace on master**
3. Дождаться загрузки VS Code в браузере

### Развернуть и протестировать

```bash
# Создать .env
cp .env.test .env
sed -i 's/YOUR_DEVNET_WALLET_ADDRESS_HERE/11111111111111111111111111111111/' .env

# Установить зависимости и запустить тесты
cd backend && npm install && npm test && cd ..

# Поднять Docker-стек
docker compose up --build -d
docker compose logs -f backend
```

Ожидать: `FlashSol v6 API running on port 3001 [devnet]`

### Добавить project wallet в БД (один раз)

```bash
docker exec -it flashsol_db psql -U flashsol -d flashsol -c \
  "INSERT INTO users (wallet) VALUES ('11111111111111111111111111111111') ON CONFLICT DO NOTHING;"
```

### Проверить API

```bash
curl http://localhost:3001/health
curl http://localhost:3001/api/levels | jq
curl http://localhost:3001/api/stats | jq

# Регистрация пользователей
curl -s -X POST http://localhost:3001/api/register \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv"}' | jq

curl -s -X POST http://localhost:3001/api/register \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM","referrer":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv"}' | jq

# Подготовка транзакции
curl -s -X POST http://localhost:3001/api/deposit/prepare \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM","levelId":0}' | jq
```

### Закоммитить

```bash
cd /workspaces/flashsol_v6
git add . && git commit -m "описание" && git push
```

---

## Этап 1 — Бесплатный старт

**Railway + Supabase + GitHub Pages • 0 $/мес**

> ⚠️ Railway бесплатный план усыпляет сервис после 30 минут неактивности. Первый запрос после паузы занимает ~10 сек. Приемлемо для старта.

### Сервисы

| Назначение | Сервис | Лимит бесплатно | Сайт |
|-----------|--------|----------------|------|
| Бэкенд | Railway | 500 часов/мес | [railway.app](https://railway.app) |
| PostgreSQL | Supabase | 500 MB, без лимита | [supabase.com](https://supabase.com) |
| Frontend | GitHub Pages | без лимита | [pages.github.com](https://pages.github.com) |

### Шаг 1 — PostgreSQL на Supabase

1. Зарегистрироваться на [supabase.com](https://supabase.com)
2. **New Project** → задать название и пароль БД
3. **Settings → Database → Connection string → URI** → скопировать строку
4. **Project → SQL Editor** → вставить содержимое `backend/src/db/schema.sql` → **Run**
5. В SQL Editor выполнить INSERT project wallet:

```sql
INSERT INTO users (wallet) VALUES ('<ваш_project_wallet>') ON CONFLICT DO NOTHING;
```

### Шаг 2 — Бэкенд на Railway

1. Зарегистрироваться на [railway.app](https://railway.app) через GitHub
2. **New Project → Deploy from GitHub repo → flashsol_v6**
3. **Settings → Root Directory**: `backend`
4. **Variables** → добавить переменные:

```
DATABASE_URL=<строка из Supabase>
PROJECT_WALLET=<ваш mainnet адрес>
SOLANA_NETWORK=mainnet-beta
RPC_URL=https://api.mainnet-beta.solana.com
ADMIN_SECRET=<случайная строка 32+ символа>
FRONTEND_URL=https://<логин>.github.io/flashsol_v6
DB_SSL=true
NODE_ENV=production
PORT=3001
```

5. **Deploy** → дождаться зелёного статуса
6. **Settings → Networking** → скопировать URL вида: `https://flashsol-v6.up.railway.app`

### Шаг 3 — Frontend на GitHub Pages

1. Открыть `frontend/index.html`, найти блок CFG и установить:

```javascript
const CFG = {
  API_URL: "https://flashsol-v6.up.railway.app",
  NETWORK: "mainnet-beta",
  PROJECT_WALLET: "<ваш_project_wallet>",
};
```

2. Закоммитить и запушить изменения
3. **GitHub → репозиторий → Settings → Pages → Source: master → /frontend → Save**
4. Через 1–2 минуты фронтенд: `https://<логин>.github.io/flashsol_v6`

### Проверить production

```bash
curl https://flashsol-v6.up.railway.app/health
curl https://flashsol-v6.up.railway.app/api/stats | jq
```

✅ Этап 1 завершён. Проект работает полностью бесплатно.

---

## Этап 2 — Платный базовый

**Hetzner VPS + Supabase + GitHub Pages • 5–10 $/мес**

> Переходите на Этап 2 когда Railway начинает требовать оплату, растёт аудитория, или нужна стабильная работа без холодного старта.

### Сервисы

| Назначение | Сервис | Цена | Сайт |
|-----------|--------|------|------|
| VPS (бэкенд) | Hetzner CX22 | ~4 $/мес | [hetzner.com](https://hetzner.com) |
| PostgreSQL | Supabase (остаётся) | 0–5 $/мес | [supabase.com](https://supabase.com) |
| Frontend | GitHub Pages (остаётся) | 0 $ | — |

### Шаг 1 — Создать VPS на Hetzner

1. Зарегистрироваться на [hetzner.com](https://hetzner.com)
2. **New Server → Location: Финляндия → Image: Ubuntu 22.04 → Type: CX22**
3. **SSH Keys** → добавить свой публичный ключ → **Create & Buy**
4. Подключиться: `ssh root@<IP_сервера>`

### Шаг 2 — Установить Docker

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
apt install -y git nginx certbot python3-certbot-nginx
```

### Шаг 3 — Развернуть проект

```bash
git clone https://github.com/igpavlov2018/flashsol_v6.git
cd flashsol_v6 && cp .env.test .env && nano .env
```

Заполнить `.env` (DATABASE_URL из Supabase):

```
DATABASE_URL=<строка из Supabase>
PROJECT_WALLET=<ваш mainnet адрес>
SOLANA_NETWORK=mainnet-beta
RPC_URL=https://api.mainnet-beta.solana.com
ADMIN_SECRET=<строка 32+ символа>
FRONTEND_URL=https://<логин>.github.io/flashsol_v6
DB_SSL=true
NODE_ENV=production

# Запустить только бэкенд (БД на Supabase)
docker compose up --build -d backend
```

### Шаг 4 — Настроить Nginx и SSL

```bash
nano /etc/nginx/sites-available/flashsol
```

Вставить:

```nginx
server {
    listen 80;
    server_name ваш-домен.com;
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/flashsol /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d ваш-домен.com
```

### Шаг 5 — Обновить фронтенд

В `frontend/index.html` изменить `API_URL` на новый домен, закоммитить и запушить.

✅ Этап 2 завершён. Стабильный сервер без холодного старта.

---

## Этап 3 — Полная автономия + Смарт-контракт

**VPS + Docker + PostgreSQL + Anchor программа • 10–20 $/мес**

> Этот этап совмещает переезд на полностью автономную инфраструктуру с миграцией на смарт-контракт Solana. Выполняется как единый переход.

### Что меняется

| Компонент | Этап 2 | Этап 3 |
|-----------|--------|--------|
| PostgreSQL | Supabase (внешний) | Docker на своём VPS |
| Бизнес-логика | Централизованный бэкенд | Anchor смарт-контракт on-chain |
| Верификация выплат | Бэкенд проверяет on-chain | Контракт исполняет сам |
| Зависимости | Supabase + Railway | Только свой VPS |
| Доверие | Нужно доверять бэкенду | Trustless — код открыт |

---

### Часть A — Переезд на локальный PostgreSQL

#### Шаг 1 — Обновить VPS

```bash
ssh root@<IP_сервера>
cd flashsol_v6 && git pull
```

#### Шаг 2 — Изменить пароль БД в docker-compose.yml

```bash
nano docker-compose.yml
# Найти и заменить:
# POSTGRES_PASSWORD: <надёжный_пароль>
```

#### Шаг 3 — Обновить .env

```bash
nano .env
# Изменить DATABASE_URL на локальную строку:
# DATABASE_URL=postgresql://flashsol:<надёжный_пароль>@postgres:5432/flashsol
# DB_SSL=false
```

#### Шаг 4 — Экспортировать данные из Supabase

В Supabase SQL Editor выполнить и скачать как CSV:

```sql
SELECT * FROM users ORDER BY registered_at;
SELECT * FROM deposits ORDER BY created_at;
SELECT * FROM referral_payouts ORDER BY created_at;
SELECT * FROM global_stats;
```

#### Шаг 5 — Запустить весь стек с локальной БД

```bash
# Остановить старый бэкенд
docker compose stop backend

# Запустить весь стек (PostgreSQL + бэкенд)
docker compose up --build -d

# Добавить project wallet
docker exec -it flashsol_db psql -U flashsol -d flashsol -c \
  "INSERT INTO users (wallet) VALUES ('<project_wallet>') ON CONFLICT DO NOTHING;"
```

#### Шаг 6 — Импортировать данные из Supabase

```bash
# Скопировать CSV файлы на сервер
scp users.csv deposits.csv referral_payouts.csv root@<IP>:/root/

# Импортировать
docker exec -it flashsol_db psql -U flashsol -d flashsol -c \
  "\COPY users FROM '/root/users.csv' CSV HEADER;"
docker exec -it flashsol_db psql -U flashsol -d flashsol -c \
  "\COPY deposits FROM '/root/deposits.csv' CSV HEADER;"
docker exec -it flashsol_db psql -U flashsol -d flashsol -c \
  "\COPY referral_payouts FROM '/root/referral_payouts.csv' CSV HEADER;"
```

✅ Часть A завершена. PostgreSQL работает локально, Supabase больше не нужен.

---

### Часть B — Миграция на смарт-контракт (Anchor)

> ⚠️ Часть B выполняется только после полного тестирования смарт-контракта на devnet. Не совмещайте деплой контракта и переезд БД в один день.

#### Что даёт смарт-контракт

- Логика выплат исполняется on-chain — бэкенд не участвует в переводах
- Trustless: пользователь видит код контракта и может проверить математику
- Реферальные цепочки хранятся в PDA-аккаунтах
- Бэкенд остаётся, но только для регистрации и чтения данных

#### Шаг 1 — Установить Anchor на VPS

```bash
# Установить Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Установить Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Установить Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install latest && avm use latest

# Проверить
anchor --version
```

#### Шаг 2 — Деплой контракта на devnet

```bash
cd flashsol_contract
solana config set --url devnet
anchor build
anchor deploy
# Сохранить Program ID из вывода
```

#### Шаг 3 — Обновить конфигурацию бэкенда

```bash
nano .env
# Добавить:
# PROGRAM_ID=<Program_ID_из_anchor_deploy>
# USE_SMART_CONTRACT=true
```

#### Шаг 4 — Протестировать на devnet

```bash
anchor test
curl http://localhost:3001/api/levels | jq
curl http://localhost:3001/api/stats | jq
```

#### Шаг 5 — Деплой контракта на mainnet

```bash
solana config set --url mainnet-beta
solana balance  # убедиться что достаточно SOL (~2–3 SOL)
anchor deploy
# Обновить PROGRAM_ID в .env на mainnet адрес
docker compose restart backend
```

#### Шаг 6 — Миграция данных в on-chain аккаунты

> ⚠️ Перед запуском сделайте резервную копию БД: `docker exec flashsol_db pg_dump -U flashsol flashsol > backup.sql`

```bash
node scripts/migrate-to-chain.js \
  --rpc https://api.mainnet-beta.solana.com \
  --program-id <PROGRAM_ID> \
  --db-url postgresql://flashsol:<пароль>@localhost:5432/flashsol
```

✅ Этап 3 завершён. Полная автономия + логика выплат on-chain в смарт-контракте.

---

## 7. Миграция между этапами

### Этап 1 → Этап 2

1. Создать VPS на Hetzner, установить Docker
2. Клонировать репозиторий, скопировать `.env` — `DATABASE_URL` из Supabase не меняется
3. `docker compose up --build -d backend`
4. Настроить Nginx и SSL
5. Обновить `API_URL` в `frontend/index.html`, закоммитить
6. Убедиться что новый сервер работает, затем отключить Railway

> ⚠️ Не отключайте Railway до тех пор, пока новый сервер не проверен в production.

### Этап 2 → Этап 3

Переход совмещён с деплоем смарт-контракта. Следовать разделу 6 полностью — сначала Часть A, затем Часть B.

| Порядок действий | Время | Риск |
|-----------------|-------|------|
| 1. Экспорт данных из Supabase | 10 мин | Нет |
| 2. Запуск локального PostgreSQL | 15 мин | Низкий |
| 3. Импорт данных | 20 мин | Средний — проверить кол-во строк |
| 4. Переключение на локальную БД | 5 мин | Средний |
| 5. Тест контракта на devnet | Несколько дней | Нет |
| 6. Деплой контракта на mainnet | 30 мин | Высокий — нужен SOL |
| 7. Миграция данных в on-chain | 1–2 часа | Высокий — сделать backup |

---

## 8. Справочник API

| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/health` | Проверка работоспособности |
| GET | `/api/levels` | Список уровней с суммами и выплатами |
| GET | `/api/stats` | Глобальная статистика |
| POST | `/api/register` | Регистрация (`wallet`, `referrer?`) |
| GET | `/api/user/:wallet` | Данные пользователя |
| GET | `/api/user/:wallet/referrals` | Список рефералов |
| POST | `/api/deposit/prepare` | Построить транзакцию для Phantom (`wallet`, `levelId`) |
| POST | `/api/deposit/confirm` | Подтвердить депозит (`wallet`, `levelId`, `txSignature`) |
| GET | `/api/admin/overview` | Обзор системы (заголовок `X-Admin-Secret`) |
| GET | `/api/admin/users` | Список пользователей (`?limit=50&offset=0`) |

### Флоу депозита

1. `POST /api/deposit/prepare` → получить `transactionBase64` и `chain`
2. Phantom десериализует транзакцию, показывает пользователю для подписи
3. Пользователь подписывает → транзакция уходит on-chain
4. `POST /api/deposit/confirm` с `txSignature` → бэкенд верифицирует on-chain
5. Депозит записывается в БД, кеш инвалидируется

> Payload кешируется 10 минут между `prepare` и `confirm`. Если истёк — повторить `prepare`.

---

## 9. Диагностика

| Ошибка | Решение |
|--------|---------|
| `InternalError` при регистрации | Project wallet не в таблице `users`. Выполнить INSERT из Шага 3. |
| `PrepareExpired` | Прошло более 10 минут после `prepare`. Повторить `/deposit/prepare`. |
| `InvalidTransferAmount` | Транзакция подписана с изменёнными суммами. |
| `AlreadyDeposited` | Адрес уже сделал депозит. Каждый адрес — один депозит. |
| `LevelBelowSponsor` | Выбранный уровень ниже уровня спонсора. |
| `npm error: esbuild` (macOS) | `rm -rf node_modules package-lock.json && npm install` |
| `Cannot find module jest-util` | `npm remove jest ts-jest @types/jest && npm install --save-dev jest@29 ts-jest@29 @types/jest@29` |
| `version obsolete` (docker compose) | Предупреждение, не ошибка. Удалить строку `version` из `docker-compose.yml`. |
| CORS ошибка на фронтенде | Проверить `FRONTEND_URL` в `.env` — должен точно совпадать с доменом фронтенда. |

### Команды диагностики

```bash
# Логи бэкенда в реальном времени
docker compose logs -f backend

# Статус контейнеров
docker compose ps

# Подключиться к БД
docker exec -it flashsol_db psql -U flashsol -d flashsol

# Посмотреть всех пользователей
docker exec -it flashsol_db psql -U flashsol -d flashsol -c "SELECT * FROM users;"

# Перезапустить бэкенд
docker compose restart backend

# Резервная копия БД
docker exec flashsol_db pg_dump -U flashsol flashsol > backup_$(date +%Y%m%d).sql
```

---

## 10. Безопасность

### Реализованные меры (Фаза 1)

- Payload кешируется между `prepare` и `confirm` — цепочка выплат не пересчитывается
- Строгая верификация транзакции: проверяются суммы и адреса по балансовым дельтам on-chain
- `SELECT FOR UPDATE` — защита от race condition при параллельных запросах
- Rate limiting: 60 запросов в минуту на `/api/`
- Helmet — защитные HTTP-заголовки
- CORS ограничен списком доменов в production
- Timing-safe сравнение для `ADMIN_SECRET`
- Транзакции PostgreSQL с `ROLLBACK` при любой ошибке

### Дополнительные меры на Фазе 2 (смарт-контракт)

- Логика выплат исполняется on-chain — бэкенд не может подменить суммы
- Anchor constraints проверяют уровни и реферальные цепочки на уровне контракта
- PDA-аккаунты не требуют доверия к оператору
- Рекомендуется аудит контракта перед mainnet-деплоем

### Чеклист перед mainnet

- [ ] Заменить стандартный пароль PostgreSQL в `docker-compose.yml`
- [ ] Установить точный `FRONTEND_URL` в `.env`
- [ ] Использовать надёжный `ADMIN_SECRET` (мин. 32 символа)
- [ ] Настроить HTTPS через Certbot
- [ ] Никогда не коммитить `.env` в git
- [ ] Сделать резервную копию приватного ключа `PROJECT_WALLET`
- [ ] Перед деплоем контракта — аудит или тщательное тестирование на devnet
- [ ] Перед миграцией данных в on-chain — сделать `pg_dump` бэкап

> ⚠️ Бэкенд участвует только до подписи транзакции. После подписи пользователем SOL идут on-chain напрямую — бэкенд их не касается.
