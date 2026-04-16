import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { cache } from '../utils/cache';
import { logger } from '../utils/logger';
import { getGlobalStats, pool } from '../registry';

export const adminRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'Admin not configured' });
  const auth = (req.headers['x-admin-secret'] || req.query.secret || '') as string;
  const secretBuf = Buffer.from(secret, 'utf8');
  const authBuf   = Buffer.from(auth,   'utf8');
  if (secretBuf.length !== authBuf.length || !crypto.timingSafeEqual(secretBuf, authBuf)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

adminRouter.get('/overview', requireAdmin, async (_req, res) => {
  try {
    const stats = await getGlobalStats();
    const recentDeposits = await pool.query(`
      SELECT d.wallet, d.level_id, d.amount_sol, d.tx_signature, d.confirmed_at
      FROM deposits d WHERE d.tx_confirmed = TRUE
      ORDER BY d.confirmed_at DESC LIMIT 20
    `);
    const LEVEL_NAMES: Record<number, string> = { 0:'Starter',1:'Basic',2:'Pro',3:'Elite' };
    const recentEvents = recentDeposits.rows.map(d => ({
      type: 'deposit', user: d.wallet,
      amount: parseFloat(d.amount_sol),
      level: d.level_id, levelName: LEVEL_NAMES[d.level_id] || '—',
      sig: d.tx_signature, ts: d.confirmed_at,
    }));
    res.json({ ok: true, data: {
      totalDepositedSol: parseFloat(stats.total_deposited),
      totalUsers: stats.total_users,
      totalRefPaidSol: parseFloat(stats.total_ref_paid),
      network: process.env.SOLANA_NETWORK || 'devnet',
      recentEvents, uptime: process.uptime(),
      memMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }});
  } catch (e) {
    logger.error('GET /admin/overview error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});

adminRouter.post('/cache/clear', requireAdmin, (_req, res) => {
  try { cache.clear(); res.json({ ok: true, message: 'Cache cleared' }); }
  catch (e) { res.status(500).json({ ok: false, error: 'InternalError' }); }
});

adminRouter.get('/users', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT wallet, referrer, active_level, total_deposited, total_earned,
              referral_count, registered_at, deposited_at
       FROM users ORDER BY registered_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const count = await pool.query('SELECT COUNT(*) FROM users');
    res.json({ ok: true, data: { users: result.rows, total: parseInt(count.rows[0].count), limit, offset }});
  } catch (e) {
    logger.error('GET /admin/users error', e);
    res.status(500).json({ ok: false, error: 'InternalError' });
  }
});
