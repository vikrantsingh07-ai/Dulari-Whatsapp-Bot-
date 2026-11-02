/**
 * End-to-end through the REAL Workers runtime (workerd via `wrangler dev`): Worker + Durable Object alarm + Postgres via Hyperdrive,
 * with a mock server standing in for WhatsApp, Telegram and Claude. Needs a throwaway Postgres on TEST_DATABASE_URL (TCP).
 *   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5544/dulari npm run e2e
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { startMock } from './mock.js';
import { signBody } from '../../src/whatsapp/signature.js';
import { getPool, query, closePool } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';

const DB = process.env.TEST_DATABASE_URL;
if (!DB) throw new Error('Set TEST_DATABASE_URL (TCP url to a throwaway Postgres)');
const MOCK = 8799, WORKER = 8788, SECRET = 'app-secret', WA = '919999900001';
const base = `http://127.0.0.1:${WORKER}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) failed++; };
async function until(fn: () => boolean | Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(300); } return false; }

getPool(DB); await migrate();
await query('truncate contacts, brain_snapshots, kv cascade');
const { server: mock, calls } = await startMock(MOCK);

writeFileSync('.dev.vars', Object.entries({
  NODE_ENV: 'development', WHATSAPP_IS_TEST_NUMBER: 'true', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify',
  WHATSAPP_API_BASE: `http://127.0.0.1:${MOCK}`, TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`, LLM_PROVIDER: 'openrouter', OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK}/api/v1`, OPENROUTER_API_KEY: 'k', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '-100', TELEGRAM_WEBHOOK_SECRET: 'tgsecret', ADMIN_TOKEN: 'admin', BRAIN_SOURCE: 'file',
}).map(([k, v]) => `${k}=${v}`).join('\n'));

const wr = spawn('npx', ['wrangler', 'dev', '--port', String(WORKER), '--ip', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: DB, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
});
let log = '';
wr.stdout.on('data', (d) => (log += d)); wr.stderr.on('data', (d) => (log += d));
const cleanup = async () => { wr.kill('SIGTERM'); mock.close(); rmSync('.dev.vars', { force: true }); await closePool(); };

try {
  const up = await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 90_000);
  check('worker boots in workerd and reaches Postgres through Hyperdrive', up, log.slice(-1500));
  if (!up) throw new Error('worker did not start');

  const post = (payload: unknown, sig?: string) => {
    const raw = JSON.stringify(payload);
    return fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? signBody(raw, SECRET) }, body: raw });
  };
  const inbound = (id: string, text: string) => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
    contacts: [{ profile: { name: 'Riya' }, wa_id: WA }], messages: [{ from: WA, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

  check('verification handshake', (await (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=abc`)).text()) === 'abc');
  check('forged webhook is rejected (401)', (await post(inbound('wamid.X', 'hi'), 'sha256=deadbeef')).status === 401);

  const t0 = Date.now();
  const r = await post(inbound('wamid.IN1', 'daily table price?'));
  check('valid webhook acked 200 in under 2s', r.status === 200 && Date.now() - t0 < 2000, `${r.status} in ${Date.now() - t0}ms`);
  await post(inbound('wamid.IN1', 'daily table price?')); // Meta resends

  const texts = () => calls.wa.filter((m) => m?.type === 'text').map((m) => m.text.body as string);
  const got = await until(() => texts().length >= 2, 40_000);
  check('Durable Object alarm fires and the bot replies (2 bubbles)', got, JSON.stringify(calls.wa).slice(0, 600) + '\n' + log.slice(-1200));
  check('reply was cleaned (Rs. 9,500)', texts()[0] === 'The Daily Table is Rs. 9,500, solid wood.', String(texts()[0]));
  check('read receipt with typing indicator was sent', calls.wa.some((m) => m?.status === 'read' && m?.typing_indicator?.type === 'text'));
  await sleep(6000);
  check('duplicate webhook did not cause a second reply', texts().length === 2 && calls.llm.length === 1, `texts=${texts().length} llm=${calls.llm.length}`);
  const [conv] = await query('select * from conversations');
  check('conversation settled (no pending timer or plan)', conv && conv.reply_due_at === null && conv.pending_plan === null);
  check('messages stored in/out', (await query("select direction from messages order by id")).map((x: any) => x.direction).join() === 'in,out,out');

  // team replies from the phone (coexistence echo) -> human mode, bot silent afterwards
  const echo = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ from: '918851472382', to: WA, id: 'wamid.ECHO1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi Riya, Akash here' } }] } }] }] };
  await post(echo);
  const human = await until(async () => (await query('select bot_mode from conversations'))[0].bot_mode === 'human', 20_000);
  check('echo from the phone switches the chat to human mode (3s delayed check)', human);
  const before = calls.wa.length;
  await post(inbound('wamid.IN2', 'ok send me the details'));
  await sleep(8000);
  check('bot stays completely silent in human mode', calls.wa.length === before && calls.llm.length === 1);

  check('telegram webhook rejects a wrong secret', (await fetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' }, body: '{}' })).status === 403);
  check('admin status needs the token', (await fetch(`${base}/admin/status`)).status === 401);
  const st: any = await (await fetch(`${base}/admin/status`, { headers: { authorization: 'Bearer admin' } })).json();
  check('admin status returns numbers', st?.stats && st?.brain?.products === 11 && Array.isArray(st.modes), JSON.stringify(st).slice(0, 300));

  // chat tester: talk to the bot as a fake customer, no WhatsApp involved
  const chatPost = (b: object, tok = 'admin') => fetch(`${base}/admin/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(b) });
  check('chat tester needs the admin token', (await chatPost({ text: 'hi' }, 'wrong')).status === 401);
  const waBefore = calls.wa.length;
  const cr: any = await (await chatPost({ id: '5', text: 'Hi, I would like to inquire about: Daily Table' })).json();
  check('chat tester returns the bot reply (2 bubbles, cleaned)', cr.replies?.length === 2 && cr.replies[0].text === 'The Daily Table is Rs. 9,500, solid wood.', JSON.stringify(cr).slice(0, 300));
  check('chat tester sent nothing through WhatsApp', calls.wa.length === waBefore);
  check('chat tester can start a fresh customer', ((await (await chatPost({ id: '5', reset: true })).json()) as any).note?.includes('New test customer'));
} catch (e) {
  console.error(e); failed++;
} finally { await cleanup(); }
console.log(failed ? `\n${failed} check(s) failed` : '\nall e2e checks passed');
process.exit(failed ? 1 : 0);
