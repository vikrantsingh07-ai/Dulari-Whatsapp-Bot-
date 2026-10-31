// npm run set-webhooks  -> registers PUBLIC_URL/telegram/webhook with Telegram (also done on boot).
import { loadConfig } from '../src/config.js';
import { Telegram } from '../src/team/telegram.js';
const cfg = loadConfig();
if (!cfg.PUBLIC_URL) throw new Error('Set PUBLIC_URL first');
await new Telegram(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID).setWebhook(`${cfg.PUBLIC_URL.replace(/\/$/, '')}/telegram/webhook`, cfg.TELEGRAM_WEBHOOK_SECRET);
console.log('Telegram webhook set.');
