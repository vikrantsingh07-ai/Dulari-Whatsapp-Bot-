import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { closePool, getPool } from './db/client.js';
import { WhatsAppClient } from './whatsapp/client.js';
import { Telegram } from './team/telegram.js';
import { BrainStore } from './brain/store.js';
import { SheetsClient } from './brain/sheets.js';
import { ClaudeClient } from './brain/claude.js';
import { ShopifyClient } from './shopify/client.js';
import { LeadsMirror } from './leads/mirror.js';
import { PgBossJobs } from './jobs/boss.js';
import { buildServer } from './webhook/routes.js';
import type { App } from './app.js';

async function main() {
  const cfg = loadConfig();
  getPool(cfg.DATABASE_URL);
  await migrate();

  const tg = new Telegram(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID);
  const sheets = cfg.GOOGLE_SERVICE_ACCOUNT_JSON ? new SheetsClient(cfg.GOOGLE_SERVICE_ACCOUNT_JSON) : null;
  const brain = new BrainStore(cfg, (t) => tg.notify(t), sheets);
  await brain.start();

  const jobs = new PgBossJobs(cfg.DATABASE_URL);
  await jobs.start();

  const app: App = {
    cfg, tg, brain, jobs,
    wa: new WhatsAppClient(cfg),
    claude: new ClaudeClient(cfg),
    shopify: ShopifyClient.maybeCreate(cfg),
    mirror: sheets && cfg.LEADS_SHEET_ID ? new LeadsMirror(sheets, cfg.LEADS_SHEET_ID) : null,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rand: Math.random,
  };
  await jobs.register(app);

  if (cfg.PUBLIC_URL) {
    await tg.setWebhook(`${cfg.PUBLIC_URL.replace(/\/$/, '')}/telegram/webhook`, cfg.TELEGRAM_WEBHOOK_SECRET).catch((e) => console.error('[telegram] setWebhook', e.message));
  }

  const server = serve({ fetch: buildServer(app).fetch, port: cfg.PORT });
  const s = brain.get().settings;
  console.log(`Dulari agent listening on :${cfg.PORT} (${cfg.WHATSAPP_IS_TEST_NUMBER ? 'TEST number' : 'REAL number'}, shadow=${s.shadowMode}, enabled=${s.botEnabled})`);
  await tg.notify(`Dulari agent started. Number: ${cfg.WHATSAPP_IS_TEST_NUMBER ? 'test' : 'real'}. Shadow mode: ${s.shadowMode ? 'ON' : 'off'}. Bot enabled: ${s.botEnabled ? 'yes' : 'NO'}.`);

  const shutdown = async () => {
    console.log('shutting down');
    server.close();
    await jobs.stop().catch(() => undefined);
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
