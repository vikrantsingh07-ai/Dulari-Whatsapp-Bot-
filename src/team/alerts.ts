import type { App } from '../app.js';
import type { Contact, Conversation, Handoff, Lead } from '../db/repo.js';
import { saveAlertRef } from '../db/repo.js';
import { describeTime } from '../engine/hours.js';
import type { TgButton } from './telegram.js';

const TYPE_LABEL: Record<string, string> = { trade: 'Trade', project: 'Project', home: 'Home', kids: 'Kids set', vendor: 'Vendor', other: 'Other' };

function who(contact: Contact, lead: Lead | null): string {
  const name = contact.name ?? `+${contact.wa_id}`;
  return lead?.firm ? `${name}, ${lead.firm}` : name;
}

export function handoffAlertText(opts: { handoff: Handoff; contact: Contact; lead: Lead | null; now: Date; repeat?: boolean; late?: boolean; shadow?: boolean }): string {
  const { handoff: h, contact, lead } = opts;
  const hot = h.urgency === 'hot' || lead?.hot;
  const head = [hot ? '🔥 HOT' : 'Handoff', lead?.type ? TYPE_LABEL[lead.type] ?? lead.type : null, lead?.city].filter(Boolean).join(' · ');
  const lines = [
    `${opts.shadow ? '[SHADOW, bot mode unchanged] ' : ''}${opts.late ? '⏰ CUSTOMER WAITING PAST PROMISED TIME\n' : opts.repeat ? '🔁 Still unclaimed\n' : ''}${head}`,
    who(contact, lead),
    ...(h.summary ?? '').split('\n').filter(Boolean),
    `Reason: ${h.reason}`,
    h.due_at ? `Promised reply by: ${describeTime(h.due_at, opts.now)}` : '',
    `Phone: +${contact.wa_id}`,
  ].filter(Boolean);
  return lines.join('\n');
}

export function handoffButtons(h: Handoff, contact: Contact): TgButton[][] {
  return [[
    { text: 'Open chat', url: `https://wa.me/${contact.wa_id}` },
    { text: 'Take', callback_data: `take:${h.id}` },
    { text: 'Release to bot', callback_data: `release:${h.conversation_id}` },
    { text: 'Snooze 1h', callback_data: `snooze:${h.id}` },
  ]];
}

export async function sendHandoffAlert(app: App, args: { handoff: Handoff; contact: Contact; lead: Lead | null; conversation: Conversation; repeat?: boolean; late?: boolean; shadow?: boolean; tagOnDuty?: boolean }) {
  let text = handoffAlertText({ ...args, now: app.now() });
  if (args.tagOnDuty) {
    const tags = app.brain.get().team.filter((t) => t.onDuty && t.telegram).map((t) => `@${t.telegram}`);
    if (tags.length) text += `\nOn duty: ${tags.join(' ')}`;
  }
  const id = await app.tg.send(text, handoffButtons(args.handoff, args.contact));
  await saveAlertRef(app.tg.chatId, id, args.conversation.id, { handoffId: args.handoff.id });
  return id;
}
