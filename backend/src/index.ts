import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { registryRouter } from './routes/registry';
import { adminRouter } from './routes/admin';
import { logger } from './utils/logger';
import { initDb } from './registry';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());

const isProduction = process.env.NODE_ENV === 'production';

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: isProduction ? allowedOrigins : '*',
  methods: ['GET', 'POST'],
  credentials: false,
}));

app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
app.use('/api/', limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', registryRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: 'v6', network: process.env.SOLANA_NETWORK, ts: Date.now() });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
const requiredEnv = ['DATABASE_URL', 'PROJECT_WALLET', 'SOLANA_NETWORK'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    logger.error(`CRITICAL: ${key} is not set`);
    process.exit(1);
  }
}

if (isProduction && !process.env.FRONTEND_URL) {
  logger.error('CRITICAL: FRONTEND_URL is not set in production!');
  process.exit(1);
}

// Инициализируем БД
initDb(process.env.DATABASE_URL!);

app.listen(PORT, () => {
  logger.info(`FlashSol v6 API running on port ${PORT} [${process.env.SOLANA_NETWORK}]`);
});

export default app;
