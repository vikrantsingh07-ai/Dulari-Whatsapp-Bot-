import { one, query } from './client.js';
import type { BotMode } from '../engine/mode.js';

export interface Contact { id: string; wa_id: string; name: string | null; language: string | null; first_seen: Date; last_seen: Date; opted_out: boolean; followup_consent: boolean; muted: boolean }
export interface Conversation {
  id: string; contact_id: string; bot_mode: BotMode; mode_changed_by: string | null; mode_changed_at: Date; owner: string | null;
  last_inbound_at: Date | null; last_human_at: Date | null; window_expires_at: Date | null; reply_due_at: Date | null;
  reply_first_at: Date | null; pending_plan: PendingPlan | null; greeted_at: Date | null; abuse_count: number;
}
export interface PendingPlan { createdAt: string; sent: number; bubbles: Array<{ kind: 'text'; text: string; replyTo?: string | null } | { kind: 'image'; url: string; caption: string }>; react: string | null; reactTo: string | null }
export interface MessageRow {
  id: number; conversation_id: string; wa_message_id: string; direction: 'in' | 'out' | 'echo'; author: 'customer' | 'bot' | 'human';
  type: string; text: string | null; media_id: string | null; mime_type: string | null; filename: string | null; transcript: string | null;
  quoted_id: string | null; referral: any; status: string | null; created_at: Date; synced: boolean;
}
export interface Lead {
  contact_id: string; type: string | null; firm: string | null; city: string | null; products: string[]; project_type: string | null;
  quantity: string | null; timeline: string | null; budget: string | null; source: string | null; status: string; hot: boolean;
  owner: string | null; summary: string | null; updated_at: Date;
}
export interface Handoff {
  id: string; conversation_id: string; reason: string; urgency: string; summary: string | null; created_at: Date; claimed_by: string | null;
  claimed_at: Date | null; due_at: Date | null; last_alert_at: Date | null; alert_count: number; holding_sent_at: Date | null; snoozed_until: Date | null; resolved_at: Date | null;
}

// ---------- contacts / conversations ----------
export async function upsertContact(waId: string, name?: string | null): Promise<Contact> {
  return (await one<Contact>(
    `insert into contacts (wa_id, name) values ($1, $2)
     on conflict (wa_id) do update set last_seen = now(), name = coalesce(contacts.name, excluded.name)
     returning *`, [waId, name ?? null]))!;
}

export async function getOrCreateConversation(contactId: string): Promise<Conversation> {
  return (await one<Conversation>(
    `insert into conversations (contact_id) values ($1)
     on conflict (contact_id) do update set contact_id = excluded.contact_id returning *`, [contactId]))!;
}

export const getConversation = (id: string) => one<Conversation>('select * from conversations where id = $1', [id]);
export const getContact = (id: string) => one<Contact>('select * from contacts where id = $1', [id]);
export const getContactByWaId = (waId: string) => one<Contact>('select * from contacts where wa_id = $1', [waId]);
export const getConversationByContactWa = (waId: string) =>
  one<Conversation>('select c.* from conversations c join contacts k on k.id = c.contact_id where k.wa_id = $1', [waId]);

export async function setBotMode(conversationId: string, mode: BotMode, by: string): Promise<void> {
  await query('update conversations set bot_mode = $2, mode_changed_by = $3, mode_changed_at = now() where id = $1', [conversationId, mode, by]);
}

// ---------- messages ----------
export interface NewMessage {
  conversationId: string; waMessageId: string; direction: 'in' | 'out' | 'echo'; author: 'customer' | 'bot' | 'human';
  type?: string; text?: string | null; mediaId?: string | null; mimeType?: string | null; filename?: string | null;
  quotedId?: string | null; referral?: unknown; status?: string | null; synced?: boolean; createdAt?: Date;
}
/** Returns the row, or null if wa_message_id already existed (duplicate webhook). */
export async function insertMessage(m: NewMessage): Promise<MessageRow | null> {
  return one<MessageRow>(
    `insert into messages (conversation_id, wa_message_id, direction, author, type, text, media_id, mime_type, filename, quoted_id, referral, status, synced, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14, now()))
     on conflict (wa_message_id) do nothing returning *`,
    [m.conversationId, m.waMessageId, m.direction, m.author, m.type ?? 'text', m.text ?? null, m.mediaId ?? null, m.mimeType ?? null,
     m.filename ?? null, m.quotedId ?? null, m.referral ? JSON.stringify(m.referral) : null, m.status ?? null, m.synced ?? false, m.createdAt ?? null]);
}

export const recentMessages = (conversationId: string, limit = 30) =>
  query<MessageRow>('select * from (select * from messages where conversation_id = $1 order by created_at desc, id desc limit $2) t order by created_at asc, id asc', [conversationId, limit]);

/** Customer messages after the last thing we (bot/human) said. */
export const pendingInbound = (conversationId: string) =>
  query<MessageRow>(
    `select * from messages m where conversation_id = $1 and direction = 'in' and synced = false
       and m.id > coalesce((select max(id) from messages where conversation_id = $1 and direction in ('out','echo') and type <> 'interim' and synced = false), 0)
     order by id asc`, [conversationId]);

export async function countNewInboundSince(conversationId: string, lastSeenId: number): Promise<number> {
  const r = await one<{ n: string }>(`select count(*) n from messages where conversation_id = $1 and direction = 'in' and synced = false and id > $2`, [conversationId, lastSeenId]);
  return Number(r?.n ?? 0);
}

export async function consecutiveBotOutSinceInbound(conversationId: string): Promise<number> {
  const r = await one<{ n: string }>(
    `select count(*) n from messages where conversation_id = $1 and direction = 'out' and author = 'bot'
       and id > coalesce((select max(id) from messages where conversation_id = $1 and direction = 'in'), 0)`, [conversationId]);
  return Number(r?.n ?? 0);
}

export async function botGreetedWithin(conversationId: string, hours: number): Promise<boolean> {
  const r = await one(`select 1 from conversations where id = $1 and greeted_at > now() - make_interval(hours => $2)`, [conversationId, hours]);
  return !!r;
}
export const markGreeted = (conversationId: string) => query('update conversations set greeted_at = now() where id = $1', [conversationId]);

export const updateMessageStatus = (waMessageId: string, status: string, errorCode?: string | null) =>
  one<MessageRow>('update messages set status = $2, error_code = coalesce($3, error_code) where wa_message_id = $1 returning *', [waMessageId, status, errorCode ?? null]);

export const getMessageByWaId = (waId: string) => one<MessageRow>('select * from messages where wa_message_id = $1', [waId]);

// ---------- reply scheduling ----------
export async function touchInbound(conversationId: string, at: Date): Promise<void> {
  await query(`update conversations set last_inbound_at = $2::timestamptz, window_expires_at = $2::timestamptz + interval '24 hours' where id = $1`, [conversationId, at]);
}
export async function setReplyDue(conversationId: string, dueAt: Date, firstAt: Date): Promise<void> {
  await query('update conversations set reply_due_at = $2, reply_first_at = $3 where id = $1', [conversationId, dueAt, firstAt]);
}
export async function clearReplyDue(conversationId: string): Promise<void> {
  await query('update conversations set reply_due_at = null, reply_first_at = null where id = $1', [conversationId]);
}
/** Clears the due time only if no newer message re-armed it while we were working. */
export async function clearReplyDueUnlessNewer(conversationId: string, claimedAt: Date): Promise<void> {
  await query(`update conversations set reply_due_at = null, reply_first_at = null where id = $1 and (reply_due_at is null or reply_due_at <= $2)`, [conversationId, claimedAt]);
}
export const conversationsOverdueForReply = () =>
  query<{ id: string; wa_id: string }>(`select c.id, k.wa_id from conversations c join contacts k on k.id = c.contact_id where c.reply_due_at is not null and c.reply_due_at < now() - interval '20 seconds'`);
export async function setPendingPlan(conversationId: string, plan: PendingPlan | null): Promise<void> {
  await query('update conversations set pending_plan = $2 where id = $1', [conversationId, plan ? JSON.stringify(plan) : null]);
}
export const markHumanActive = (conversationId: string) => query('update conversations set last_human_at = now() where id = $1', [conversationId]);

// ---------- leads ----------
export const getLead = (contactId: string) => one<Lead>('select * from leads where contact_id = $1', [contactId]);

const LEAD_TEXT_FIELDS = ['type', 'firm', 'city', 'project_type', 'quantity', 'timeline', 'budget', 'source', 'status', 'summary', 'owner'] as const;
export type LeadPatch = Partial<Record<(typeof LEAD_TEXT_FIELDS)[number], string>> & { products?: string[]; hot?: boolean };

export async function upsertLead(contactId: string, patch: LeadPatch): Promise<Lead> {
  await query('insert into leads (contact_id) values ($1) on conflict do nothing', [contactId]);
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [contactId];
  for (const f of LEAD_TEXT_FIELDS) {
    const v = patch[f];
    if (typeof v === 'string' && v.trim()) { params.push(v.trim()); sets.push(`${f} = $${params.length}`); }
  }
  if (patch.products?.length) {
    params.push(patch.products);
    sets.push(`products = (select coalesce(array_agg(distinct p), '{}') from unnest(products || $${params.length}::text[]) p)`);
  }
  if (patch.hot === true) sets.push('hot = true');
  return (await one<Lead>(`update leads set ${sets.join(', ')} where contact_id = $1 returning *`, params))!;
}

export const setLeadSourceIfEmpty = (contactId: string, source: string) =>
  query(`insert into leads (contact_id, source) values ($1,$2) on conflict (contact_id) do update set source = coalesce(leads.source, excluded.source)`, [contactId, source]);

export const updateContactProfile = (contactId: string, patch: { name?: string; language?: string }) =>
  query('update contacts set name = coalesce($2, name), language = coalesce($3, language) where id = $1', [contactId, patch.name ?? null, patch.language ?? null]);

// ---------- handoffs ----------
export const createHandoff = (h: { conversationId: string; reason: string; urgency: string; summary: string; dueAt: Date }) =>
  one<Handoff>(`insert into handoffs (conversation_id, reason, urgency, summary, due_at, last_alert_at) values ($1,$2,$3,$4,$5, now()) returning *`,
    [h.conversationId, h.reason, h.urgency, h.summary, h.dueAt]);
export const openHandoff = (conversationId: string) =>
  one<Handoff>('select * from handoffs where conversation_id = $1 and resolved_at is null order by created_at desc limit 1', [conversationId]);
export const getHandoff = (id: string) => one<Handoff>('select * from handoffs where id = $1', [id]);
export const claimHandoff = (id: string, by: string) =>
  one<Handoff>('update handoffs set claimed_by = $2, claimed_at = now() where id = $1 returning *', [id, by]);
export const resolveHandoffs = (conversationId: string) => query('update handoffs set resolved_at = now() where conversation_id = $1 and resolved_at is null', [conversationId]);
export const snoozeHandoff = (id: string, until: Date) => query('update handoffs set snoozed_until = $2 where id = $1', [id, until]);
export const markHoldingSent = (id: string, newDue: Date) => query('update handoffs set holding_sent_at = now(), due_at = $2, last_alert_at = now(), alert_count = alert_count + 1 where id = $1', [id, newDue]);
export const unclaimedHandoffsNeedingRepeat = () =>
  query<Handoff>(`select * from handoffs where resolved_at is null and claimed_by is null and last_alert_at < now() - interval '30 minutes'
                    and (snoozed_until is null or snoozed_until < now()) and alert_count < 6`);
export const touchHandoffAlert = (id: string) => query('update handoffs set last_alert_at = now(), alert_count = alert_count + 1 where id = $1', [id]);

// ---------- follow-ups ----------
export const cancelFollowups = (conversationId: string, reason: string) =>
  query(`update followups set cancelled_reason = $2 where conversation_id = $1 and sent_at is null and cancelled_reason is null`, [conversationId, reason]);
export const createFollowup = (conversationId: string, template: string, dueAt: Date) =>
  one<{ id: string }>('insert into followups (conversation_id, template, due_at) values ($1,$2,$3) returning id', [conversationId, template, dueAt]);
export const getFollowup = (id: string) => one<{ id: string; conversation_id: string; template: string; due_at: Date; sent_at: Date | null; cancelled_reason: string | null }>('select * from followups where id = $1', [id]);
export const markFollowupSent = (id: string) => query('update followups set sent_at = now() where id = $1', [id]);

// ---------- misc ----------
export const logLlmCall = (c: { conversationId?: string | null; purpose: string; model: string; inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; cost?: number | null; latencyMs?: number; error?: string | null }) =>
  query('insert into llm_calls (conversation_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, latency_ms, error) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [c.conversationId ?? null, c.purpose, c.model, c.inputTokens ?? null, c.outputTokens ?? null, c.cacheRead ?? null, c.cacheWrite ?? null, c.cost ?? null, c.latencyMs ?? null, c.error ?? null]);

export const saveMedia = (mediaId: string, mime: string, data: Buffer) =>
  query('insert into media (media_id, mime_type, data) values ($1,$2,$3) on conflict (media_id) do nothing', [mediaId, mime, data]);
export const getMedia = (mediaId: string) => one<{ media_id: string; mime_type: string; data: Buffer }>('select * from media where media_id = $1', [mediaId]);

export const saveAlertRef = (chatId: string, messageId: number, conversationId: string, ids: { handoffId?: string; draftId?: string } = {}) =>
  query('insert into alerts (chat_id, message_id, conversation_id, handoff_id, draft_id) values ($1,$2,$3,$4,$5) on conflict do nothing', [chatId, messageId, conversationId, ids.handoffId ?? null, ids.draftId ?? null]);
export const alertRef = (chatId: string, messageId: number) =>
  one<{ conversation_id: string; handoff_id: string | null; draft_id: string | null }>('select * from alerts where chat_id = $1 and message_id = $2', [chatId, messageId]);

export const createDraft = (conversationId: string, bubbles: unknown, customerText: string) =>
  one<{ id: string }>('insert into drafts (conversation_id, bubbles, customer_text) values ($1,$2,$3) returning id', [conversationId, JSON.stringify(bubbles), customerText]);
export const rateDraft = (id: string, rating: 'up' | 'down') => query('update drafts set rating = $2 where id = $1', [id, rating]);

export const saveBrainSnapshot = (data: unknown) => query('insert into brain_snapshots (data) values ($1)', [JSON.stringify(data)]);
export const latestBrainSnapshot = () => one<{ data: any; created_at: Date }>('select * from brain_snapshots order by id desc limit 1');

export async function kvGet<T = any>(key: string): Promise<T | null> { return (await one<{ value: T }>('select value from kv where key = $1', [key]))?.value ?? null; }
export const kvSet = (key: string, value: unknown) =>
  query('insert into kv (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(value)]);

export async function forgetContact(waId: string): Promise<boolean> {
  const rows = await query('delete from contacts where wa_id = $1 returning id', [waId]);
  return rows.length > 0;
}
export async function purgeOlderThan(months: number): Promise<number> {
  const m = await query(`delete from messages where created_at < now() - make_interval(months => $1) returning 1`, [months]);
  await query(`delete from media where created_at < now() - make_interval(months => $1)`, [months]);
  return m.length;
}

export const leadsForMirror = () =>
  query<Lead & { wa_id: string; name: string | null; bot_mode: string }>(
    `select l.*, k.wa_id, k.name, c.bot_mode from leads l join contacts k on k.id = l.contact_id left join conversations c on c.contact_id = k.id order by l.updated_at desc`);

export const dayStats = () =>
  one<{ new_leads: string; hot_unanswered: string; handoffs_open: string; followups_today: string }>(
    `select (select count(*) from leads where created_at > now() - interval '24 hours') new_leads,
            (select count(*) from handoffs where resolved_at is null and urgency = 'hot' and claimed_by is null) hot_unanswered,
            (select count(*) from handoffs where resolved_at is null) handoffs_open,
            (select count(*) from followups where sent_at is null and cancelled_reason is null and due_at < now() + interval '24 hours') followups_today`);
