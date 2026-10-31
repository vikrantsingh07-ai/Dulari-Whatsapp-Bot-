import { closePool, getPool, query } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';
import { parseBrain } from '../../src/brain/parse.js';
import { parseStudioHours } from '../../src/engine/hours.js';
import type { App } from '../../src/app.js';
import type { Jobs } from '../../src/jobs/types.js';
import type { InboundMessage } from '../../src/whatsapp/events.js';
import type { Brain } from '../../src/brain/types.js';

export const DB_URL = process.env.TEST_DATABASE_URL;

export const goodTables = {
  products: [
    ['name', 'website handle', 'other names', 'price', 'size', 'woods', 'finishes', 'lead time', 'in stock', 'photo urls', 'product url', 'active'],
    ['Daily Table', 'mini-table', '', '9500', '120x60 cm', 'teak', 'hand-rubbed oil', '3 weeks', 'yes', 'https://img.test/daily1.jpg', 'https://dulari.design/products/mini-table', 'yes'],
    ['Binge Chair', 'binge-chair', '', '11000', '', 'ash', 'oil', '4 weeks', 'yes', 'https://img.test/binge1.jpg', 'https://dulari.design/products/binge-chair', 'yes'],
  ],
  faq: [['question', 'answer'], ['Where is the experience center?', 'Gurugram']],
  policies: [['topic', 'text'], ['delivery', 'Free in Delhi NCR']],
  settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['SHADOW_MODE', 'FALSE'], ['BOT_ENABLED', 'TRUE']],
  team: [['name', 'telegram handle', 'on duty'], ['Akash', 'akash', 'yes']],
};

export class Clock { offset = 0; now = () => new Date(Date.now() + this.offset); advance(ms: number) { this.offset += ms; } }

export interface Sent { kind: 'text' | 'image' | 'reaction' | 'template' | 'read'; to?: string; body?: string; replyTo?: string | null; emoji?: string }

export function makeApp(over: { settings?: string[][] } = {}) {
  const clock = new Clock();
  const sent: Sent[] = [];
  const tgMessages: { text: string; buttons?: unknown }[] = [];
  const scheduled: { waId: string; conversationId: string; dueAt: Date }[] = [];
  const claudeCalls: any[] = [];
  const script: Array<(args: any) => any> = [];
  let waSeq = 0;

  const parsed = parseBrain({ ...goodTables, settings: over.settings ?? goodTables.settings });
  if (!parsed.brain) throw new Error('bad test brain: ' + parsed.errors.join('; '));
  const brain: Brain = parsed.brain;

  const wa = {
    sendText: async (to: string, body: string, replyTo?: string | null) => { sent.push({ kind: 'text', to, body, replyTo }); return `wamid.OUT${++waSeq}`; },
    sendImage: async (to: string, link: string, caption: string) => { sent.push({ kind: 'image', to, body: caption + '|' + link }); return `wamid.OUT${++waSeq}`; },
    sendReaction: async (to: string, _id: string, emoji: string) => { sent.push({ kind: 'reaction', to, emoji }); return `wamid.OUT${++waSeq}`; },
    sendTemplate: async (to: string, name: string) => { sent.push({ kind: 'template', to, body: name }); return `wamid.OUT${++waSeq}`; },
    markReadTyping: async (id: string) => { sent.push({ kind: 'read', body: id }); },
    downloadMedia: async () => { throw new Error('no media in tests'); },
    ping: async () => ({ ok: true, detail: 'fake' }),
  };
  const jobs: Jobs = {
    scheduleReply: async (waId, conversationId, dueAt) => { scheduled.push({ waId, conversationId, dueAt }); },
    scheduleEchoCheck: async () => {}, scheduleMediaDownload: async () => {}, scheduleFollowup: async () => {}, scheduleHolding: async () => {}, scheduleResend: async () => {},
  };
  const claude = {
    mainModel: 'main', fastModel: 'fast',
    call: async (args: any) => { claudeCalls.push(args); const f = script.shift(); if (!f) throw new Error('unscripted Claude call: ' + args.purpose); return f(args); },
  };
  const app = {
    cfg: { WHATSAPP_BUSINESS_NUMBER: '918851472382', TELEGRAM_CHAT_ID: '-100' } as any,
    wa, jobs, claude, shopify: null, mirror: null,
    tg: {
      chatId: '-100',
      send: async (text: string, buttons?: unknown) => { tgMessages.push({ text, buttons }); return 1000 + tgMessages.length; },
      notify: async (text: string) => { tgMessages.push({ text }); },
      answerCallback: async () => {}, clearButtons: async () => {},
    },
    brain: { ensure: async () => {}, get: () => brain, getHours: () => parseStudioHours(brain.settings.studioHours, brain.settings.holidays), isLoaded: () => true, lastSyncOk: null, lastSyncError: null },
    now: clock.now, sleep: async () => {}, rand: () => 0.5,
  } as unknown as App;
  return { app, clock, sent, tgMessages, scheduled, claudeCalls, script, brain };
}

export const reply = (o: { messages: string[]; react?: string | null; reply_to?: string | null }) => () => ({
  content: [{ type: 'text', text: JSON.stringify({ messages: o.messages, react: o.react ?? null, reply_to: o.reply_to ?? null }) }],
  stop_reason: 'end_turn', usage: {},
});
export const toolUse = (name: string, input: unknown, id = 'tu_' + name) => () => ({
  content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: {},
});

let n = 0;
export const inbound = (text: string, from = '919999900001', extra: Partial<InboundMessage> = {}): InboundMessage => ({
  kind: 'inbound', waMessageId: `wamid.IN${Date.now()}_${++n}`, from, profileName: 'Riya', timestamp: new Date(), type: 'text', text, ...extra,
});

export async function setupDb() {
  getPool(DB_URL);
  await migrate();
  await query('truncate contacts, brain_snapshots, kv cascade');
}
export async function teardownDb() { await closePool(); }
