import { logger } from './logger';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ── Cache backend selection ───────────────────────────────────────────────────
// По умолчанию используется in-memory кеш (подходит для devnet и dev-режима).
// Для production установите REDIS_URL=rediss://... — кеш автоматически переключится на Redis.
//
// Установка ioredis: npm install ioredis (уже добавлен в dependencies)
// Формат Upstash: rediss://default:PASSWORD@HOST:PORT

// ── In-memory cache ───────────────────────────────────────────────────────────
const store = new Map<string, CacheEntry<unknown>>();

const memCache = {
  get<T>(key: string): T | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value as T;
  },

  set<T>(key: string, value: T, ttlSeconds: number): void {
    store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },

  del(key: string): void {
    store.delete(key);
  },

  clear(): void {
    const count = store.size;
    store.clear();
    logger.info(`Cache cleared (${count} entries)`);
  },

  size(): number {
    return store.size;
  },
};

// ── Redis cache ───────────────────────────────────────────────────────────────
// Активируется автоматически при наличии REDIS_URL в окружении.
// Используется ioredis — поддерживает Upstash (rediss://) и стандартный Redis.

let _redisCache: typeof memCache | null = null;

function buildRedisCache(redisUrl: string): typeof memCache {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
  });

  client.on('error', (err: Error) => {
    logger.error('Redis error — falling back to in-memory cache', { error: err.message });
    _redisCache = null; // автоматический fallback
  });

  client.connect().catch((err: Error) => {
    logger.error('Redis connect failed — falling back to in-memory cache', { error: err.message });
    _redisCache = null;
  });

  logger.info(`Cache: Redis (${redisUrl.replace(/:[^:@]+@/, ':***@')})`);

  return {
    get<T>(key: string): T | null {
      // Redis-операции асинхронны, но cache.get() используется синхронно через cached().
      // Для Redis используем только async путь через cached().
      // Синхронный get возвращает null (будет промах, async cached() перехватит).
      return null;
    },
    set<T>(key: string, value: T, ttlSeconds: number): void {
      client.setex(key, ttlSeconds, JSON.stringify(value)).catch(() => {});
    },
    del(key: string): void {
      client.del(key).catch(() => {});
    },
    clear(): void {
      client.flushdb().then(() => logger.info('Redis cache cleared')).catch(() => {});
    },
    size(): number {
      return -1; // Redis size недоступен синхронно
    },
  };
}

// ── Async Redis helpers ────────────────────────────────────────────────────────
let _redisClient: any = null;

function getRedisClient(): any | null {
  if (!process.env.REDIS_URL) return null;
  if (_redisClient) return _redisClient;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    _redisClient = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
    });
    _redisClient.on('error', (err: Error) => {
      logger.error('Redis client error', { error: err.message });
    });
    logger.info(`Redis cache enabled: ${process.env.REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
    return _redisClient;
  } catch (e) {
    logger.warn('ioredis not installed — falling back to in-memory cache. Run: npm install ioredis');
    return null;
  }
}

// ── Unified cache interface ────────────────────────────────────────────────────
export const cache = {
  get<T>(key: string): T | null {
    return memCache.get<T>(key);
  },

  set<T>(key: string, value: T, ttlSeconds: number): void {
    memCache.set(key, value, ttlSeconds);
    // Записываем в Redis параллельно (best-effort)
    const rc = getRedisClient();
    if (rc) rc.setex(key, ttlSeconds, JSON.stringify(value)).catch(() => {});
  },

  del(key: string): void {
    memCache.del(key);
    const rc = getRedisClient();
    if (rc) rc.del(key).catch(() => {});
  },

  clear(): void {
    memCache.clear();
    const rc = getRedisClient();
    if (rc) rc.flushdb().then(() => logger.info('Redis cache flushed')).catch(() => {});
  },

  size(): number {
    return memCache.size();
  },
};

/** Wrap an async function with cache.
 *  При наличии REDIS_URL читает из Redis при промахе in-memory (пережил рестарт).
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  // 1. In-memory hit (быстрый путь)
  const hit = memCache.get<T>(key);
  if (hit !== null) return hit;

  // 2. Redis hit (пережил рестарт контейнера)
  const rc = getRedisClient();
  if (rc) {
    try {
      const raw = await rc.get(key);
      if (raw) {
        const value = JSON.parse(raw) as T;
        memCache.set(key, value, ttlSeconds); // прогреваем in-memory
        return value;
      }
    } catch { /* ignore, proceed to fn() */ }
  }

  // 3. Cache miss — вычисляем и сохраняем
  const value = await fn();
  memCache.set(key, value, ttlSeconds);
  if (rc) rc.setex(key, ttlSeconds, JSON.stringify(value)).catch(() => {});
  return value;
}
