/**
 * One-command guided setup:  npm run setup
 * Asks plain questions, then: logs in to Cloudflare, creates the database tables, connects the database,
 * deploys the bot, stores your secrets, connects Telegram, and tells you exactly what to paste into Meta.
 * Re-run it any time: it skips what is already done and lets you replace secrets.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import {
  currentHyperdriveId, extractSheetId, fillPassword, looksLikePostgres, needsPassword, parseHyperdriveId, parseWorkerUrl, patchHyperdriveId,
  pickGroupChatId, patchVar, randomToken, toBase64,
} from './setup-lib.js';

const WRANGLER = 'wrangler.jsonc';
// Run wrangler's own JS with the current Node: no shell, no npx. (npx.cmd fails silently on Windows, and a shell would mangle & and % in passwords.)
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const say = (s = '') => console.log(s);
const step = (n: number, title: string) => say(`\n━━ Step ${n}: ${title} ━━`);

function ask(q: string, opts: { secret?: boolean; optional?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (opts.secret) (rl as any)._writeToOutput = (s: string) => process.stdout.write(s.includes(q) ? s : '*');
    rl.question(q, (a) => { rl.close(); if (opts.secret) process.stdout.write('\n'); resolve(a.trim()); });
  });
}
async function required(q: string, opts: { secret?: boolean; check?: (v: string) => string | null } = {}): Promise<string> {
  for (;;) {
    const v = await ask(q, opts);
    if (!v) { say('  (this one is needed)'); continue; }
    const problem = opts.check?.(v);
    if (problem) { say(`  ${problem}`); continue; }
    return v;
  }
}
function run(args: string[], opts: { capture?: boolean } = {}) {
  const r = spawnSync(process.execPath, [wranglerBin, ...args], { encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit' });
  const err = r.error ? `\n(could not start wrangler: ${r.error.message})` : '';
  return { ok: r.status === 0 && !r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}${err}` };
}

async function main() {
  say('Dulari WhatsApp bot setup. It takes about 10 minutes. Have these ready (see docs/SETUP.md if not):');
  say('  - Supabase database link   - OpenRouter (or Anthropic) key   - Meta (WhatsApp) token, phone number id, app secret');
  say('  - Telegram bot token       - Google sheet links + service account key file\n');
  await ask('Press Enter to start ');

  // 1 ─ Cloudflare login
  step(1, 'Log in to Cloudflare');
  const who = run(['whoami'], { capture: true });
  if (!who.ok || !/logged in/i.test(who.out)) {
    say('A browser window will open. Log in and click Allow.');
    if (!run(['login']).ok) throw new Error('Cloudflare login did not finish. Run this again.');
  } else say('Already logged in.');

  // 2 ─ Database
  step(2, 'Database');
  say('In Supabase: Connect -> "Session pooler" -> copy the connection string.');
  let dbUrl = await required('Paste it here: ', { secret: true, check: (v) => (looksLikePostgres(v) ? null : 'That does not look like a postgres:// link.') });
  if (needsPassword(dbUrl)) dbUrl = fillPassword(dbUrl, await required('Your Supabase database password: ', { secret: true }));
  say('Creating the tables...');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: dbUrl, ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  await client.query(readFileSync(join(process.cwd(), 'src/db/schema.sql'), 'utf8'));
  await client.end();
  say('Tables ready.');

  // 3 ─ Hyperdrive
  step(3, 'Connect the database to Cloudflare');
  let jsonc = readFileSync(WRANGLER, 'utf8');
  if (currentHyperdriveId(jsonc)) say('Already connected.');
  else {
    let res = run(['hyperdrive', 'create', 'dulari-db', `--connection-string=${dbUrl}`], { capture: true });
    let id = res.ok ? parseHyperdriveId(res.out) : null;
    if (!id && /already exists/i.test(res.out)) id = parseHyperdriveId(run(['hyperdrive', 'list'], { capture: true }).out, 'dulari-db');
    if (!id) throw new Error(`Could not create the connection:\n${res.out.split(dbUrl).join('***')}`);
    jsonc = patchHyperdriveId(jsonc, id);
    writeFileSync(WRANGLER, jsonc);
    say('Connected.');
  }

  // 4 ─ Keys
  step(4, 'Your keys (typing is hidden)');
  const secrets: Record<string, string> = {};
  say('AI service the bot will use to write replies:');
  say('  1 = OpenRouter (one key, many models, some free)     2 = Anthropic (Claude directly)');
  const provider = (await ask('Choose 1 or 2 (Enter = 1): ')) === '2' ? 'anthropic' : 'openrouter';
  let llmModel: string, llmFast: string;
  if (provider === 'openrouter') {
    secrets.OPENROUTER_API_KEY = await required('OpenRouter API key: ', { secret: true });
    say('Model name: copy it from openrouter.ai/models (looks like "vendor/model-name"). It must support tool calling.');
    llmModel = (await ask('Main model (Enter = openrouter/free, lets OpenRouter pick a free one): ')) || 'openrouter/free';
    llmFast = (await ask(`Cheaper model for small jobs (Enter = same as main): `)) || llmModel;
  } else {
    secrets.ANTHROPIC_API_KEY = await required('Anthropic API key: ', { secret: true });
    llmModel = 'claude-sonnet-5-5'; llmFast = 'claude-haiku-5-5';
  }
  say('\nMeta / WhatsApp (developers.facebook.com -> your app -> WhatsApp):');
  secrets.WHATSAPP_TOKEN = await required('  Access token: ', { secret: true });
  secrets.WHATSAPP_PHONE_NUMBER_ID = await required('  Phone number ID: ');
  secrets.WHATSAPP_APP_SECRET = await required('  App secret: ', { secret: true });

  say('\nTelegram:');
  secrets.TELEGRAM_BOT_TOKEN = await required('  Bot token from BotFather: ', { secret: true });
  say('  Now open Telegram and send any message in the "Dulari Leads" group (the bot must be a member).');
  await ask('  Press Enter after you sent it ');
  const tg = (m: string, body?: unknown) => fetch(`https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/${m}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((r) => r.json() as Promise<any>);
  await tg('deleteWebhook');
  let chat = pickGroupChatId(await tg('getUpdates'));
  while (!chat) {
    say('  I could not find the group. Make sure the bot is in the group, send a message there, and try again.');
    await ask('  Press Enter to retry ');
    chat = pickGroupChatId(await tg('getUpdates'));
  }
  say(`  Found the group "${chat.title}".`);
  secrets.TELEGRAM_CHAT_ID = chat.id;

  say('\nGoogle sheets (open each sheet and copy the link from the browser):');
  const brain = await required('  "Dulari Bot Brain" link: ', { check: (v) => (extractSheetId(v) ? null : 'That does not look like a sheet link.') });
  secrets.BRAIN_SHEET_ID = extractSheetId(brain)!;
  const leads = await ask('  "Dulari Leads" link (Enter to skip): ');
  if (leads && extractSheetId(leads)) secrets.LEADS_SHEET_ID = extractSheetId(leads)!;
  const keyPath = await required('  Path to the service account key file (.json, you can drag the file here): ', {
    check: (v) => { try { JSON.parse(readFileSync(v.replace(/^['"]|['"]$/g, '').trim(), 'utf8')); return null; } catch { return 'I could not read a JSON file there.'; } },
  });
  secrets.GOOGLE_SERVICE_ACCOUNT_JSON = toBase64(readFileSync(keyPath.replace(/^['"]|['"]$/g, '').trim(), 'utf8'));

  secrets.WHATSAPP_VERIFY_TOKEN = randomToken();
  secrets.TELEGRAM_WEBHOOK_SECRET = randomToken();
  secrets.ADMIN_TOKEN = randomToken();

  // 5 ─ Deploy
  step(5, 'Put the bot online');
  jsonc = readFileSync(WRANGLER, 'utf8');
  jsonc = patchVar(patchVar(patchVar(jsonc, 'LLM_PROVIDER', provider), 'LLM_MODEL', llmModel), 'LLM_FAST_MODEL', llmFast);
  writeFileSync(WRANGLER, jsonc);
  const dep = run(['deploy'], { capture: true });
  if (!dep.ok) throw new Error(`Deploy failed:\n${dep.out}`);
  const url = parseWorkerUrl(dep.out);
  if (!url) throw new Error(`Deployed, but I could not find the address in:\n${dep.out}`);
  say(`Online at ${url}`);

  // 6 ─ Secrets
  step(6, 'Store the keys safely in Cloudflare');
  const dir = mkdtempSync(join(tmpdir(), 'dulari-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const r = run(['secret', 'bulk', file], { capture: true });
    if (!r.ok) throw new Error(`Storing keys failed:\n${r.out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  say('Keys stored. (No copy was left on disk.)');

  // 7 ─ Telegram
  step(7, 'Connect Telegram');
  const wh = await tg('setWebhook', { url: `${url}/telegram/webhook`, secret_token: secrets.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
  say(wh.ok ? 'Telegram connected.' : `Telegram said: ${wh.description}`);

  // 8 ─ Health
  step(8, 'Check that it works');
  await new Promise((r) => setTimeout(r, 4000));
  const health = await fetch(`${url}/health`).then((r) => r.json() as Promise<any>).catch((e) => ({ ok: false, error: String(e) }));
  if (health.ok && health.brain) say('The bot is healthy and has read your Brain sheet.');
  else say(`Not healthy yet: ${JSON.stringify(health)}\nMost common cause: the Brain sheet is not shared with the service account email, or a tab name is wrong.`);

  const summary = `Dulari bot, setup summary
Bot address:           ${url}
Meta Callback URL:     ${url}/webhook
Meta Verify token:     ${secrets.WHATSAPP_VERIFY_TOKEN}
Dashboard admin token: ${secrets.ADMIN_TOKEN}
`;
  writeFileSync('setup-summary.txt', summary);
  say('\n━━ Last thing: tell Meta where your bot lives ━━');
  say('Meta app -> WhatsApp -> Configuration -> Webhook -> Edit, then paste:');
  say(`  Callback URL:  ${url}/webhook`);
  say(`  Verify token:  ${secrets.WHATSAPP_VERIFY_TOKEN}`);
  say('Click Verify and save, then tick "messages" under Webhook fields.');
  say('\nThese were also saved to setup-summary.txt (keep it private, it is not uploaded to git).');
  say('\nTest: send your test number a WhatsApp message. Because shadow mode is ON, a draft reply appears in your Telegram group instead of going to the customer.');
}

main().catch((e) => { console.error(`\nStopped: ${e.message}`); process.exit(1); });
