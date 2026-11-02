/**
 * npm run check-token
 * Tests a WhatsApp access token against your phone number and says exactly what is wrong. Nothing is stored.
 */
import readline from 'node:readline';
import { checkToken } from './check-token-lib.js';

function ask(q: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) (rl as any)._writeToOutput = (s: string) => process.stdout.write(s.includes(q) ? s : '*');
    rl.question(q, (a) => { rl.close(); if (secret) process.stdout.write('\n'); resolve(a.trim()); });
  });
}
const token = await ask('Access token to test (typing is hidden): ', true);
const id = (await ask('Phone number ID [Enter = 1409853438878361]: ')) || '1409853438878361';
const r = await checkToken((...a) => fetch(...a), token, id);
console.log(`\n${r.ok ? 'OK: ' : 'PROBLEM: '}${r.message}`);
if (r.ok) console.log('Store this exact token with:  npx wrangler secret put WHATSAPP_TOKEN');
process.exit(r.ok ? 0 : 1);
