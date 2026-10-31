import type { App } from '../app.js';
import {
  alertRef, claimHandoff, dayStats, forgetContact, getContactByWaId, getConversation, getConversationByContactWa, getHandoff, getLead,
  openHandoff, rateDraft, resolveHandoffs, setBotMode, snoozeHandoff, upsertLead,
} from '../db/repo.js';
import { query } from '../db/client.js';

interface TgUser { id: number; username?: string; first_name?: string }
const nameOf = (u: TgUser | undefined) => u?.username ? `@${u.username}` : u?.first_name ?? 'someone';

export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

export async function releaseChat(app: App, conversationId: string): Promise<void> {
  await resolveHandoffs(conversationId);
  await setBotMode(conversationId, 'auto', 'telegram_release');
}

/** Resolves which conversation a command is about: reply to an alert, or an explicit phone number. */
async function targetConversation(app: App, msg: any, arg: string) {
  const replied = msg.reply_to_message?.message_id;
  if (replied) {
    const ref = await alertRef(String(msg.chat.id), replied);
    if (ref) return getConversation(ref.conversation_id);
  }
  const phone = normalisePhone(arg.split(/\s+/)[0] ?? '');
  if (phone) return getConversationByContactWa(phone);
  return null;
}

export async function handleTelegramUpdate(app: App, update: any): Promise<void> {
  const chatId = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? '');
  if (chatId !== app.tg.chatId) return; // only the Dulari Leads group may command the bot

  if (update.callback_query) return handleCallback(app, update.callback_query);
  const msg = update.message;
  const text: string = msg?.text ?? '';
  if (!text.startsWith('/')) return;
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw!.split('@')[0]!.toLowerCase();
  const arg = rest.join(' ').trim();
  const by = nameOf(msg.from);
  const reply = (t: string) => app.tg.send(t, undefined, msg.message_id).catch(() => undefined);

  switch (cmd) {
    case '/take': {
      const conv = await targetConversation(app, msg, arg);
      if (!conv) return void reply('Reply to an alert (or add the phone number): /take');
      await setBotMode(conv.id, 'human', 'telegram_take');
      const h = await openHandoff(conv.id);
      if (h) await claimHandoff(h.id, by);
      await upsertLead(conv.contact_id, { owner: by });
      return void reply(`${by} has it. Bot is silent on this chat.`);
    }
    case '/release': {
      const conv = await targetConversation(app, msg, arg);
      if (!conv) return void reply('Reply to an alert (or add the phone number): /release');
      await releaseChat(app, conv.id);
      return void reply('Released. The bot handles this chat again.');
    }
    case '/shadow': {
      const conv = await targetConversation(app, msg, arg);
      if (!conv) return void reply('Reply to an alert (or add the phone number): /shadow');
      await setBotMode(conv.id, 'shadow', 'telegram_shadow');
      return void reply('This chat is in shadow mode. Drafts will appear here instead of being sent.');
    }
    case '/note': {
      const conv = await targetConversation(app, msg, '');
      const note = arg;
      if (!conv || !note) return void reply('Reply to an alert with: /note <text>');
      const lead = await getLead(conv.contact_id);
      await upsertLead(conv.contact_id, { summary: [lead?.summary, `Note (${by}): ${note}`].filter(Boolean).join('\n') });
      return void reply('Note added to the lead.');
    }
    case '/status': {
      const s = await dayStats();
      const modes = await query<{ bot_mode: string; n: string }>('select bot_mode, count(*) n from conversations group by bot_mode');
      return void reply([
        `New leads (24h): ${s?.new_leads ?? 0}`, `Hot leads unanswered: ${s?.hot_unanswered ?? 0}`, `Open handoffs: ${s?.handoffs_open ?? 0}`,
        `Follow-ups going out in 24h: ${s?.followups_today ?? 0}`, `Chats by mode: ${modes.map((m) => `${m.bot_mode} ${m.n}`).join(', ') || 'none'}`,
        `Brain last synced: ${app.brain.lastSyncOk?.toISOString() ?? 'never'}${app.brain.lastSyncError ? ` (problem: ${app.brain.lastSyncError.slice(0, 120)})` : ''}`,
      ].join('\n'));
    }
    case '/forget': {
      const phone = normalisePhone(arg);
      if (!phone) return void reply('Usage: /forget <phone number>');
      return void reply((await forgetContact(phone)) ? `Deleted all stored data for +${phone}.` : `Nothing stored for +${phone}.`);
    }
    case '/optin': {
      const phone = normalisePhone(arg);
      const c = phone ? await getContactByWaId(phone) : null;
      if (!c) return void reply('Usage: /optin <phone number> (they must have clearly agreed to follow-ups)');
      await query('update contacts set opted_out = false, followup_consent = true where id = $1', [c.id]);
      return void reply(`Recorded: +${c.wa_id} agreed to follow-up messages.`);
    }
    case '/help':
    case '/start':
      return void reply('Commands (reply to an alert): /take /release /shadow /note <text>\nAnywhere: /status, /forget <number>, /optin <number>');
  }
}

async function handleCallback(app: App, cb: any): Promise<void> {
  const [action, id] = String(cb.data ?? '').split(':');
  const by = nameOf(cb.from);
  const msgId: number | undefined = cb.message?.message_id;
  if (!action || !id) return void app.tg.answerCallback(cb.id);
  switch (action) {
    case 'take': {
      const h = await getHandoff(id);
      if (!h) return void app.tg.answerCallback(cb.id, 'Handoff not found');
      await claimHandoff(h.id, by);
      await setBotMode(h.conversation_id, 'human', 'telegram_take');
      const conv = await getConversation(h.conversation_id);
      if (conv) await upsertLead(conv.contact_id, { owner: by });
      await app.tg.answerCallback(cb.id, 'Yours');
      return void app.tg.send(`${by} took this one.`, undefined, msgId);
    }
    case 'release': {
      await releaseChat(app, id);
      await app.tg.answerCallback(cb.id, 'Released to bot');
      return void app.tg.send(`${by} released the chat back to the bot.`, undefined, msgId);
    }
    case 'snooze': {
      await snoozeHandoff(id, new Date(Date.now() + 3_600_000));
      return void app.tg.answerCallback(cb.id, 'Snoozed for 1 hour');
    }
    case 'draft_up':
    case 'draft_down': {
      await rateDraft(id, action === 'draft_up' ? 'up' : 'down');
      await app.tg.answerCallback(cb.id, action === 'draft_up' ? 'Thanks, 👍 saved' : 'Thanks, 👎 saved');
      if (msgId) await app.tg.clearButtons(msgId);
      return;
    }
  }
}
