/**
 * npm run subscribe
 * One-time fix when Meta does not deliver real WhatsApp messages to the bot: subscribes your app to your
 * WhatsApp Business Account. Asks for the access token (hidden) and the account id. Nothing is stored.
 */
import readline from 'node:readline';
import { subscribeWaba } from './subscribe-waba-lib.js';

function ask(q: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) (rl as any)._writeToOutput = (s: string) => process.stdout.write(s.includes(q) ? s : '*');
    rl.question(q, (a) => { rl.close(); if (secret) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const token = await ask('Meta access token (typing is hidden): ', true);
const waba = (await ask('WhatsApp account id ("Messaging account ID" in API Setup) [Enter = 2194934211366490]: ')) || '2194934211366490';
try {
  const r = await subscribeWaba((...a) => fetch(...a), token, waba);
  const show = (l: { name?: string; id?: string; override?: string }[]) => (l.length ? l.map((a) => `  - ${a.name ?? '?'} (${a.id ?? '?'})${a.override ? ` OVERRIDE CALLBACK: ${a.override}` : ''}`).join('\n') : '  (none)');
  console.log(`\nApps subscribed BEFORE:\n${show(r.before)}\n\nSubscribe request: ${r.success ? 'success' : 'did not say success'}\n\nApps subscribed NOW:\n${show(r.after)}`);
  if (r.after.some((a) => a.override)) console.log('\nNote: an app has an OVERRIDE callback URL. Webhooks go there instead of your bot. Tell Claude.');
  console.log('\nNow send a WhatsApp message to the test number and check the Cloudflare logs again.');
} catch (e) {
  console.error(`\nFailed: ${(e as Error).message}\nIf it says the token is invalid or lacks permission, use a fresh token (or the permanent one) that has whatsapp_business_management.`);
  process.exit(1);
}
