# FlashSol v6 — Локальное тестирование

## Быстрый старт

### 1. Подготовка
```bash
cd flashsol_v6

# Создай .env файл
cp .env.test .env

# Открой .env и замени PROJECT_WALLET на свой devnet кошелёк
# (получить адрес: solana address)
nano .env
```

### 2. Запуск через Docker
```bash
docker-compose up --build
```

Дождись сообщений:
```
flashsol_db      | database system is ready to accept connections
flashsol_backend | FlashSol v6 API running on port 3001 [devnet]
```

### 3. Проверка бэкенда
```bash
# Health check
curl http://localhost:3001/health

# Ожидаемый ответ:
# {"ok":true,"version":"v6","network":"devnet","ts":...}
```

### 4. Запуск API тестов
```bash
bash scripts/test-api.sh
```

### 5. Тест фронтенда
Открой `frontend/index.html` в браузере (Live Server в VS Code или просто двойной клик).

Заполни в `index.html` в блоке CFG:
```js
PROJECT_WALLET: 'твой_devnet_адрес',
API_URL:        'http://localhost:3001',
NETWORK:        'devnet',
```

### 6. End-to-end тест с Phantom
1. Установи Phantom, переключи на devnet
2. Получи тестовые SOL: `solana airdrop 2`
3. Открой фронтенд, подключи кошелёк
4. Попробуй сделать депозит на Starter (0.5 SOL)
5. Проверь кабинет — заработок должен появиться

## Остановка
```bash
docker-compose down

# Удалить данные БД (чистый старт):
docker-compose down -v
```

## Логи
```bash
# Все сервисы
docker-compose logs -f

# Только бэкенд
docker-compose logs -f backend

# Только БД
docker-compose logs -f postgres
```
