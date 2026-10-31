import type { App } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { withDb } from '../db/client.js';
import { BrainStore } from '../brain/store.js';
import { SheetsClient } from '../brain/sheets.js';
import { ClaudeClient } from '../brain/claude.js';
import { ShopifyClient } from '../shopify/client.js';
import { LeadsMirror } from '../leads/mirror.js';
import { Telegram } from '../team/telegram.js';
import { WhatsAppClient } from '../whatsapp/client.js';
import type { Jobs } from '../jobs/types.js';
import type { Env } from './env.js';

export function makeConfig(env: Env): Config {
  const strings = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return loadConfig({ ...strings, DATABASE_URL: env.HYPERDRIVE.connectionString } as NodeJS.ProcessEnv);
}

// One BrainStore per isolate: it caches the sheet and refreshes itself (see BrainStore.ensure).
let brainSingleton: BrainStore | undefined;

export function buildApp(env: Env, jobs: Jobs): App {
  const cfg = makeConfig(env);
  const tg = new Telegram(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID, cfg.TELEGRAM_API_BASE);
  const sheets = cfg.GOOGLE_SERVICE_ACCOUNT_JSON ? new SheetsClient(cfg.GOOGLE_SERVICE_ACCOUNT_JSON, cfg.GOOGLE_SHEETS_BASE, cfg.GOOGLE_TOKEN_URL) : null;
  brainSingleton ??= new BrainStore(cfg, (t) => tg.notify(t), sheets);
  return {
    cfg, tg, jobs, brain: brainSingleton,
    wa: new WhatsAppClient(cfg),
    claude: new ClaudeClient(cfg),
    shopify: ShopifyClient.maybeCreate(cfg),
    mirror: sheets && cfg.LEADS_SHEET_ID ? new LeadsMirror(sheets, cfg.LEADS_SHEET_ID) : null,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rand: Math.random,
  };
}

/** Runs `fn` with its own Postgres connection (via Hyperdrive) and a fresh Brain cache. */
export function runDb<T>(env: Env, app: App, fn: () => Promise<T>): Promise<T> {
  return withDb(env.HYPERDRIVE.connectionString, async () => { await app.brain.ensure(); return fn(); });
}
