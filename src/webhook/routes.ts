import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.js';
import { verifySignature } from '../whatsapp/signature.js';
import { parseWebhook } from '../whatsapp/events.js';
import { handleEvents } from './ingest.js';
import { handleTelegramUpdate } from '../team/commands.js';
import { query } from '../db/client.js';

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function buildServer(app: App): Hono {
  const server = new Hono();

  server.get('/health', async (c) => {
    try {
      await query('select 1');
      return c.json({ ok: true, brain: app.brain.isLoaded(), brainSyncedAt: app.brain.lastSyncOk, brainProblem: app.brain.lastSyncError });
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
    // Store + schedule, but never keep Meta waiting: ack within ~1.5s, work continues in the background.
    const work = handleEvents(app, parseWebhook(body)).catch((e) => console.error('[webhook]', e));
    await Promise.race([work, new Promise((r) => setTimeout(r, 1500))]);
    return c.text('ok');
  });

  server.post('/telegram/webhook', async (c) => {
    const secret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEq(secret, app.cfg.TELEGRAM_WEBHOOK_SECRET)) return c.text('forbidden', 403);
    const update = await c.req.json().catch(() => null);
    if (update) await handleTelegramUpdate(app, update).catch((e) => console.error('[telegram]', e));
    return c.text('ok');
  });

  return server;
}
