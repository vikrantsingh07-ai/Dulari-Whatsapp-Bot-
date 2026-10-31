import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.js';
import { verifySignature } from '../whatsapp/signature.js';
import { parseWebhook } from '../whatsapp/events.js';
import { handleEvents } from './ingest.js';
import { handleTelegramUpdate } from '../team/commands.js';
import { query } from '../db/client.js';
import { adminStatus } from '../admin.js';

const safeEq = (a: string, b: string) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** What the hosting layer provides: a DB-scoped runner and a way to keep working after the response. */
export interface Runtime {
  db<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil(p: Promise<unknown>): void;
}

export function buildServer(app: App, rt: Runtime): Hono {
  const server = new Hono();

  server.get('/health', async (c) => {
    try {
      return await rt.db(async () => {
        await query('select 1');
        return c.json({ ok: true, brain: app.brain.isLoaded(), brainSyncedAt: app.brain.lastSyncOk, brainProblem: app.brain.lastSyncError });
      });
    } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
  });

  // Meta subscription handshake
  server.get('/webhook', (c) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = c.req.query();
    if (mode === 'subscribe' && token && safeEq(token, app.cfg.WHATSAPP_VERIFY_TOKEN)) return c.text(challenge ?? '');
    return c.text('forbidden', 403);
  });

  server.post('/webhook', async (c) => {
    const raw = await c.req.text();
    if (!verifySignature(raw, c.req.header('x-hub-signature-256'), app.cfg.WHATSAPP_APP_SECRET)) return c.text('invalid signature', 401);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return c.text('bad json', 400); }
    // Store + schedule, but never keep Meta waiting: ack within ~1.5s, the work keeps going after the response.
    const work = rt.db(() => handleEvents(app, parseWebhook(body))).catch((e) => console.error('[webhook]', e));
    rt.waitUntil(work);
    await Promise.race([work, new Promise((r) => setTimeout(r, 1500))]);
    return c.text('ok');
  });

  server.post('/telegram/webhook', async (c) => {
    const secret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEq(secret, app.cfg.TELEGRAM_WEBHOOK_SECRET)) return c.text('forbidden', 403);
    const update = await c.req.json().catch(() => null);
    if (update) await rt.db(() => handleTelegramUpdate(app, update)).catch((e) => console.error('[telegram]', e));
    return c.text('ok');
  });

  // Dashboard API (Vercel). Bearer token + CORS limited to the dashboard origin.
  const cors = (c: any) => {
    const origin = app.cfg.DASHBOARD_ORIGIN;
    if (origin) { c.header('Access-Control-Allow-Origin', origin); c.header('Vary', 'Origin'); }
    c.header('Access-Control-Allow-Headers', 'Authorization'); c.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  };
  server.options('/admin/status', (c) => { cors(c); return c.body(null, 204); });
  server.get('/admin/status', async (c) => {
    cors(c);
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!app.cfg.ADMIN_TOKEN || !safeEq(token, app.cfg.ADMIN_TOKEN)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await rt.db(() => adminStatus(app)));
  });

  return server;
}
