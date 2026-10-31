// npm run set-webhooks  -> registers PUBLIC_URL/telegram/webhook with Telegram. Run once after the first deploy.
// Needs TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL in the environment (e.g. from .dev.vars).
import { Telegram } from '../src/team/telegram.js';
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };
await new Telegram(need('TELEGRAM_BOT_TOKEN'), need('TELEGRAM_CHAT_ID')).setWebhook(`${need('PUBLIC_URL').replace(/\/$/, '')}/telegram/webhook`, need('TELEGRAM_WEBHOOK_SECRET'));
console.log('Telegram webhook set.');
