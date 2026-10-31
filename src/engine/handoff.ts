import type { App } from '../app.js';
import type { Contact, Conversation } from '../db/repo.js';
import { cancelFollowups, clearReplyDue, createHandoff, getLead, openHandoff, setBotMode, upsertLead } from '../db/repo.js';
import { computeReplyBy, describeTime, isOpenNow } from './hours.js';
import { sendHandoffAlert } from '../team/alerts.js';

export interface PendingHandoff {
  reason: string;
  urgency: 'hot' | 'normal';
  summary: string;
  replyBy: Date;
}

export function replyByFor(app: App): { date: Date; text: string; open: boolean } {
  const brain = app.brain.get();
  const hours = app.brain.getHours();
  const now = app.now();
  const date = computeReplyBy(hours, now, brain.settings.handoffReplyHours);
  return { date, text: describeTime(date, now), open: isOpenNow(hours, now) };
}

/**
 * Applies a handoff for real: human mode, handoff row, hot flag, Telegram alert.
 * In shadow mode only the alert goes out and the chat mode is left alone.
 */
export async function commitHandoff(app: App, conv: Conversation, contact: Contact, h: PendingHandoff, opts: { shadow: boolean; by?: string }): Promise<void> {
  await cancelFollowups(conv.id, 'handoff');
  await clearReplyDue(conv.id);
  if (h.urgency === 'hot') await upsertLead(contact.id, { hot: true });
  const existing = await openHandoff(conv.id);
  if (opts.shadow) {
    const fake = { id: existing?.id ?? 'shadow', conversation_id: conv.id, reason: h.reason, urgency: h.urgency, summary: h.summary, created_at: app.now(), claimed_by: null, claimed_at: null, due_at: h.replyBy, last_alert_at: null, alert_count: 1, holding_sent_at: null, snoozed_until: null, resolved_at: null };
    await app.tg.notify('(shadow) the bot would hand this chat off:');
    await sendHandoffAlert(app, { handoff: fake, contact, lead: await getLead(contact.id), conversation: conv, shadow: true }).catch((e) => console.error(e));
    return;
  }
  await setBotMode(conv.id, 'human', opts.by ?? 'bot');
  const row = await createHandoff({ conversationId: conv.id, reason: h.reason, urgency: h.urgency, summary: h.summary, dueAt: h.replyBy });
  await sendHandoffAlert(app, { handoff: row!, contact, lead: await getLead(contact.id), conversation: conv });
}
