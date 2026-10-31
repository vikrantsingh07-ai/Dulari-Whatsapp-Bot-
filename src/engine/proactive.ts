import type { App } from '../app.js';
import {
  conversationsOverdueForReply, consecutiveBotOutSinceInbound, dayStats, getContact, getConversation, getFollowup, getLead, getMessageByWaId, insertMessage,
  kvGet, kvSet, markFollowupSent, markHoldingSent, openHandoff, pendingInbound, purgeOlderThan, resolveHandoffs, saveMedia, setBotMode,
  touchHandoffAlert, unclaimedHandoffsNeedingRepeat,
} from '../db/repo.js';
import { query } from '../db/client.js';
import { effectiveMode, humanModeExpired } from './mode.js';
import { computeReplyBy, describeTime } from './hours.js';
import { sendBubble } from './sender.js';
import { sendHandoffAlert } from '../team/alerts.js';

export async function downloadMedia(app: App, mediaId: string): Promise<void> {
  const d = await app.wa.downloadMedia(mediaId); // pg-boss retries on throw
  await saveMedia(mediaId, d.mime, d.data);
}

/** Day-2 nudge. Only approved templates can be sent outside the 24h window, and only with consent. */
export async function sendFollowup(app: App, followupId: string): Promise<void> {
  const f = await getFollowup(followupId);
  if (!f || f.sent_at || f.cancelled_reason) return;
  const conv = await getConversation(f.conversation_id);
  if (!conv) return;
  const contact = (await getContact(conv.contact_id))!;
  const settings = app.brain.get().settings;
  const cancel = (reason: string) => query('update followups set cancelled_reason = $2 where id = $1', [f.id, reason]);
  if (contact.opted_out || !contact.followup_consent) return void (await cancel('no_consent'));
  const mode = effectiveMode({ conversationMode: conv.bot_mode, settings, hours: app.brain.getHours(), now: app.now() });
  if (mode === 'human' || mode === 'off') return void (await cancel(`mode_${mode}`));
  if ((await pendingInbound(conv.id)).length) return void (await cancel('customer_replied'));
  if ((await consecutiveBotOutSinceInbound(conv.id)) >= 2) return void (await cancel('already_two_unanswered'));
  if (mode === 'shadow') {
    await app.tg.notify(`(shadow) would send follow-up template "${f.template}" to +${contact.wa_id}.`);
    return void (await cancel('shadow'));
  }
  const id = await app.wa.sendTemplate(contact.wa_id, f.template, settings.followupLanguage, [contact.name ?? 'there']);
  await insertMessage({ conversationId: conv.id, waMessageId: id, direction: 'out', author: 'bot', type: 'template', text: `[template ${f.template}]`, status: 'sent' });
  await markFollowupSent(f.id);
}

/** One honest holding line when the promised time passed and nobody answered. Then quiet again. */
export async function sendHoldingLine(app: App, conversationId: string): Promise<void> {
  {
    const conv = await getConversation(conversationId);
    if (!conv || conv.bot_mode !== 'human') return;
    const h = await openHandoff(conversationId);
    if (!h || h.holding_sent_at || !h.due_at || h.due_at > app.now()) return;
    if (conv.last_human_at && conv.last_human_at > h.created_at) return;
    const contact = (await getContact(conv.contact_id))!;
    const brain = app.brain.get();
    const now = app.now();
    const newDue = computeReplyBy(app.brain.getHours(), now, brain.settings.handoffReplyHours);
    const onDuty = brain.team.find((t) => t.onDuty)?.name;
    const text = `Sorry for the wait, ${onDuty ?? 'the team'} is on the workshop floor. You'll hear back here by ${describeTime(newDue, now)}.`;
    await sendBubble(app, conv, contact, { kind: 'text', text }); // no read receipt or typing: human mode stays silent
    await markHoldingSent(h.id, newDue);
    const fresh = (await openHandoff(conversationId))!;
    await sendHandoffAlert(app, { handoff: fresh, contact, lead: await getLead(contact.id), conversation: conv, late: true, tagOnDuty: true });
  }
}

/** Unclaimed alerts repeat every 30 minutes, tagging whoever is on duty. */
export async function repeatUnclaimedAlerts(app: App): Promise<void> {
  for (const h of await unclaimedHandoffsNeedingRepeat()) {
    const conv = await getConversation(h.conversation_id);
    if (!conv) continue;
    const contact = (await getContact(conv.contact_id))!;
    await sendHandoffAlert(app, { handoff: h, contact, lead: await getLead(contact.id), conversation: conv, repeat: true, tagOnDuty: true });
    await touchHandoffAlert(h.id);
  }
}

/** Human mode ends after N quiet hours, except for trade and project leads (they wait for /release). */
export async function expireHumanMode(app: App): Promise<void> {
  const s = app.brain.get().settings;
  const rows = await query<{ id: string; mode_changed_at: Date; last_human_at: Date | null; type: string | null }>(
    `select c.id, c.mode_changed_at, c.last_human_at, l.type from conversations c left join leads l on l.contact_id = c.contact_id where c.bot_mode = 'human'`);
  for (const r of rows) {
    if (humanModeExpired({ lastHumanAt: r.last_human_at, modeChangedAt: r.mode_changed_at, now: app.now(), timeoutHours: s.humanTimeoutHours, leadType: r.type })) {
      await setBotMode(r.id, 'auto', 'human_timeout');
      await resolveHandoffs(r.id);
    }
  }
}

export async function morningDigest(app: App): Promise<void> {
  const s = await dayStats();
  const hot = await query<{ wa_id: string; name: string | null; summary: string | null; reason: string }>(
    `select k.wa_id, k.name, h.summary, h.reason from handoffs h join conversations c on c.id = h.conversation_id join contacts k on k.id = c.contact_id
      where h.resolved_at is null and h.urgency = 'hot' and h.claimed_by is null order by h.created_at limit 10`);
  await app.tg.send([
    '☀️ Morning digest',
    `New leads yesterday: ${s?.new_leads ?? 0}`,
    `Hot leads still unanswered: ${s?.hot_unanswered ?? 0}`,
    ...hot.map((h) => `  • ${h.name ?? '+' + h.wa_id}: ${h.reason}`),
    `Follow-ups going out today: ${s?.followups_today ?? 0}`,
  ].join('\n'));
}

/** Every 15 minutes: token + API reachable? Alerts on change (and again every ~2h while broken). */
export async function healthCheck(app: App): Promise<void> {
  const ping = await app.wa.ping();
  const prev = (await kvGet<{ ok: boolean; at: number }>('health:wa')) ?? { ok: true, at: 0 };
  const now = Date.now();
  if (!ping.ok && (prev.ok || now - prev.at > 2 * 3_600_000)) {
    await app.tg.notify(`⚠️ WhatsApp health check failed: ${ping.detail}\nThe token may have expired or been revoked.`);
    await kvSet('health:wa', { ok: false, at: now });
  } else if (ping.ok && !prev.ok) {
    await app.tg.notify(`✅ WhatsApp is healthy again (${ping.detail}).`);
    await kvSet('health:wa', { ok: true, at: now });
  } else if (ping.ok) await kvSet('health:wa', { ok: true, at: now });
  if (app.brain.lastSyncOk && now - app.brain.lastSyncOk.getTime() > 60 * 60_000) {
    const k = await kvGet<{ at: number }>('health:brain_stale');
    if (!k || now - k.at > 6 * 3_600_000) { await app.tg.notify('⚠️ The Brain sheet has not synced for over an hour. The bot is using the last good version.'); await kvSet('health:brain_stale', { at: now }); }
  }
}

/** Safety net: any reply that is overdue but whose job got lost gets re-queued. */
export async function sweepOverdueReplies(app: App): Promise<void> {
  for (const r of await conversationsOverdueForReply()) await app.jobs.scheduleReply(r.wa_id, r.id, app.now());
}

export async function retention(app: App): Promise<void> {
  const n = await purgeOlderThan(app.brain.get().settings.retentionMonths);
  if (n) console.log(`[retention] removed ${n} old messages`);
}

/** One retry for a failed text send whose error code was temporary. */
export async function resendFailed(app: App, waMessageId: string): Promise<void> {
  const m = await getMessageByWaId(waMessageId);
  if (!m || m.direction !== 'out' || m.type !== 'text' || !m.text) return;
  const r = await query<{ retries: number }>('update messages set retries = retries + 1 where wa_message_id = $1 and retries < 1 returning retries', [waMessageId]);
  if (!r.length) return;
  const conv = (await getConversation(m.conversation_id))!;
  const contact = (await getContact(conv.contact_id))!;
  await sendBubble(app, conv, contact, { kind: 'text', text: m.text });
}

export async function mirrorLeads(app: App): Promise<void> {
  if (app.mirror) await app.mirror.run();
}
