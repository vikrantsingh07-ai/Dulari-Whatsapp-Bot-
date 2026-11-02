/**
 * Talk to your bot as a fake customer:  npm run chat
 * Uses the real AI, your Brain sheet and tools. Nothing goes through WhatsApp, so it needs no Meta token.
 * Reads the bot address and admin token from setup-summary.txt (written by npm run setup).
 */
import { existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

function fromSummary(label: string): string | undefined {
  if (!existsSync('setup-summary.txt')) return undefined;
  return readFileSync('setup-summary.txt', 'utf8').split('\n').find((l) => l.startsWith(label))?.split(/:\s+/).slice(1).join(': ').trim();
}
const base = (process.env.BOT_URL ?? fromSummary('Bot address') ?? '').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN ?? fromSummary('Dashboard admin token');
if (!base || !token) {
  console.error('Could not find the bot address and admin token. Run "npm run setup" first (it creates setup-summary.txt), or set BOT_URL and ADMIN_TOKEN.');
  process.exit(1);
}

let customer = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
async function send(body: object): Promise<any> {
  const r = await fetch(`${base}/admin/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ id: customer, ...body }) });
  if (r.status === 401) throw new Error('Wrong admin token.');
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Bot returned ${r.status}`);
  return j;
}

console.log('Chat with your Dulari bot as a customer. Nothing is sent on WhatsApp.');
console.log('Type a message and press Enter. Commands: /new = new customer, /quit = exit.\n');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = () => rl.question('You: ', async (line) => {
  const text = line.trim();
  if (text === '/quit') return rl.close();
  if (text === '/new') {
    customer = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    console.log('(new customer, the bot remembers nothing about the old chat)\n');
    return ask();
  }
  if (!text) return ask();
  process.stdout.write('  ...thinking\r');
  try {
    const r = await send({ text });
    process.stdout.write('               \r');
    for (const m of r.replies ?? []) {
      if (m.kind === 'text') console.log(`Dulari: ${m.text}${m.replyTo ? '   (quoted reply)' : ''}`);
      else if (m.kind === 'image') console.log(`Dulari: [photo] ${m.caption || ''} ${m.url}`);
      else console.log(`Dulari: [reaction ${m.emoji}]`);
    }
    if (r.note) console.log(`  (${r.note})`);
    console.log();
  } catch (e) { process.stdout.write('               \r'); console.log(`  Problem: ${(e as Error).message}\n`); }
  ask();
});
ask();
