import type { App } from './app.js';
import { forgetContact, getConversationByContactWa } from './db/repo.js';
import { query } from './db/client.js';
import { runReply } from './engine/reply.js';
import { TEST_WA_PREFIX } from './engine/mode.js';
import { handleInbound } from './webhook/ingest.js';
import type { InboundMessage } from './whatsapp/events.js';

export type Captured = { kind: 'text'; text: string; replyTo?: string | null } | { kind: 'image'; url: string; caption: string } | { kind: 'reaction'; emoji: string };

export interface ChatResult {
  replies: Captured[];
  mode: string;
  note?: string;
}

/**
 * Chat tester: talks to the real bot (real AI, Brain sheet, tools, lead capture, handoff alerts) as a fake customer,
 * but nothing goes through WhatsApp. WhatsApp calls are captured and returned instead. Needs no Meta token.
 * Test customers have wa_ids starting with 000; the bot treats them as live even while shadow mode is on.
 */
export async function testChat(app: App, opts: { id?: string; text?: string; reset?: boolean }): Promise<ChatResult> {
  const digits = (opts.id ?? '1').replace(/\D/g, '').slice(0, 9) || '1';
  const waId = `${TEST_WA_PREFIX}${digits.padStart(7, '0')}`;

  if (opts.reset) {
    await forgetContact(waId);
    return { replies: [], mode: 'auto', note: 'New test customer. The bot has forgotten this chat.' };
  }
  const text = (opts.text ?? '').trim();
  if (!text) return { replies: [], mode: 'auto', note: 'Type a message.' };

  const out: Captured[] = [];
  let n = 0;
  const id = () => `wamid.SIM${Date.now()}_${++n}`;
  const wa = {
    sendText: async (_to: string, body: string, replyTo?: string | null) => { out.push({ kind: 'text', text: body, replyTo }); return id(); },
    sendImage: async (_to: string, url: string, caption: string) => { out.push({ kind: 'image', url, caption }); return id(); },
    sendReaction: async (_to: string, _m: string, emoji: string) => { out.push({ kind: 'reaction', emoji }); return id(); },
    sendTemplate: async () => id(),
    markReadTyping: async () => {},
    downloadMedia: async () => { throw new Error('no media in the chat tester'); },
    ping: async () => ({ ok: true, detail: 'sim' }),
  } as unknown as App['wa'];
  const noJobs = {
    scheduleReply: async () => {}, scheduleEchoCheck: async () => {}, scheduleMediaDownload: async () => {},
    scheduleFollowup: async () => {}, scheduleHolding: async () => {}, scheduleResend: async () => {},
  };

  const msg: InboundMessage = { kind: 'inbound', waMessageId: `wamid.SIMIN${Date.now()}`, from: waId, profileName: 'Test chat', timestamp: new Date(), type: 'text', text };
  await handleInbound({ ...app, jobs: noJobs }, msg); // stores the message and arms the 8s timer, no real job
  const conv = await getConversationByContactWa(waId);
  if (!conv) return { replies: [], mode: 'auto', note: 'Message was not stored.' };
  const before = conv.bot_mode;
  if (before === 'human') return { replies: [], mode: 'human', note: 'This test customer was handed to the team, so the bot stays silent (just like with a real customer). Start a new test customer to continue.' };

  // run the reply now instead of waiting 8 seconds
  const fast: App = { ...app, wa, jobs: noJobs, sleep: async () => {}, now: () => new Date(Date.now() + 10_000) };
  await runReply(fast, conv.id);
  const after = (await query<{ bot_mode: string }>('select bot_mode from conversations where id = $1', [conv.id]))[0]?.bot_mode ?? 'auto';
  return {
    replies: out, mode: after,
    note: after === 'human' ? 'The bot handed this chat to the team (check Telegram for the alert). Further messages get no reply until released.' : out.length === 0 ? 'The bot chose to stay quiet.' : undefined,
  };
}
