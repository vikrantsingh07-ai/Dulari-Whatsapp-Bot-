import type { App } from '../app.js';
import {
  cancelFollowups, getConversation, getOrCreateConversation, insertMessage, markHumanActive, openHandoff, setBotMode, setLeadSourceIfEmpty,
  setReplyDue, touchInbound, updateMessageStatus, upsertContact, clearReplyDue, claimHandoff, getMessageByWaId,
  type Conversation,
} from '../db/repo.js';
import { computeReplyDue } from '../engine/batching.js';
import { effectiveMode } from '../engine/mode.js';
import { parseEnquire } from '../brain/lookup.js';
import { TEMPORARY_ERROR_CODES } from '../whatsapp/client.js';
import type { EchoMessage, HistoryMessage, InboundMessage, StatusEvent, WaEvent } from '../whatsapp/events.js';
import type { EchoPayload } from '../jobs/types.js';

/** Types that deserve a reply. Stickers, reactions and unknowns are stored only. */
const REPLYABLE = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'button', 'interactive']);
const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video']);

function storedText(m: InboundMessage): string | null {
  if (m.type === 'location' && m.location) {
    const l = m.location;
    return `lat ${l.latitude}, lng ${l.longitude}${l.name ? `, ${l.name}` : ''}${l.address ? `, ${l.address}` : ''}`;
  }
  if (m.type === 'reaction') return m.reaction?.emoji ?? null;
  return m.text ?? m.caption ?? null;
}

/** Called from the webhook route. Quick work only: store, dedupe, schedule. */
export async function handleEvents(app: App, events: WaEvent[]): Promise<void> {
  for (const e of events) {
    try {
      if (e.kind === 'inbound') await handleInbound(app, e);
      else if (e.kind === 'echo') await app.jobs.scheduleEchoCheck({ waMessageId: e.waMessageId, to: e.to, type: e.type, text: e.text, timestamp: e.timestamp.toISOString() }, 3);
      else if (e.kind === 'status') await handleStatus(app, e);
      else if (e.kind === 'history') await handleHistory(app, e);
    } catch (err) {
      console.error('[ingest] failed for', e.kind, (e as any).waMessageId, err);
    }
  }
}

export async function handleInbound(app: App, m: InboundMessage): Promise<void> {
  // Our own number should never appear as a customer.
  if (app.cfg.WHATSAPP_BUSINESS_NUMBER && m.from === app.cfg.WHATSAPP_BUSINESS_NUMBER.replace(/\D/g, '')) return;
  const contact = await upsertContact(m.from, m.profileName);
  const conv = await getOrCreateConversation(contact.id);
  const row = await insertMessage({
    conversationId: conv.id, waMessageId: m.waMessageId, direction: 'in', author: 'customer', type: m.type, text: storedText(m),
    mediaId: m.mediaId, mimeType: m.mimeType, filename: m.filename, quotedId: m.quotedId, referral: m.referral,
  });
  if (!row) return; // Meta resent a webhook we already have
  if (!REPLYABLE.has(m.type)) return;

  await touchInbound(conv.id, new Date());
  await cancelFollowups(conv.id, 'customer_replied');
  if (m.mediaId && MEDIA_TYPES.has(m.type)) await app.jobs.scheduleMediaDownload(m.mediaId); // links expire fast
  if (m.text && parseEnquire(m.text)) await setLeadSourceIfEmpty(contact.id, 'website_enquire');

  const brain = app.brain.get();
  const mode = effectiveMode({ conversationMode: conv.bot_mode, settings: brain.settings, hours: app.brain.getHours(), now: app.now() });
  if (mode === 'human') { await maybeHoldingLine(app, conv); return; }
  if (mode === 'off' || contact.opted_out || contact.muted) return;

  const { dueAt, firstPendingAt } = computeReplyDue({
    now: app.now(), firstPendingAt: conv.reply_due_at ? conv.reply_first_at : null,
    batchSeconds: brain.settings.batchSeconds, maxSeconds: brain.settings.batchMaxSeconds,
  });
  await setReplyDue(conv.id, dueAt, firstPendingAt);
  await app.jobs.scheduleReply(conv.id, dueAt);
}

/** Promise kept: promised time passed, nobody replied, customer wrote again -> one honest line. */
async function maybeHoldingLine(app: App, conv: Conversation): Promise<void> {
  const h = await openHandoff(conv.id);
  if (!h || !h.due_at || h.holding_sent_at) return;
  if (h.due_at > app.now()) return;
  if (conv.last_human_at && conv.last_human_at > h.created_at) return;
  await app.jobs.scheduleHolding(conv.id, 8);
}

/** Echo = a team member typed from the phone app. Delayed 3s so our own sends (stored first) are ignored. */
export async function handleEcho(app: App, p: EchoPayload): Promise<void> {
  const contact = await upsertContact(p.to);
  const conv = await getOrCreateConversation(contact.id);
  const row = await insertMessage({
    conversationId: conv.id, waMessageId: p.waMessageId, direction: 'echo', author: 'human', type: p.type,
    text: p.text ?? (p.type === 'text' ? null : `[${p.type}]`), createdAt: new Date(p.timestamp),
  });
  if (!row) return; // it was one of the bot's own messages
  await markHumanActive(conv.id);
  await cancelFollowups(conv.id, 'human_replied');
  await clearReplyDue(conv.id);
  const h = await openHandoff(conv.id);
  if (h && !h.claimed_by) await claimHandoff(h.id, 'phone');
  const fresh = (await getConversation(conv.id))!;
  if (fresh.bot_mode === 'auto') await setBotMode(conv.id, 'human', 'human_echo');
}

async function handleStatus(app: App, s: StatusEvent): Promise<void> {
  const row = await updateMessageStatus(s.waMessageId, s.status, s.errorCode);
  if (s.status !== 'failed') return;
  console.warn('[wa] send failed', s.waMessageId, s.errorCode, s.errorTitle);
  const temporary = s.errorCode ? TEMPORARY_ERROR_CODES.has(s.errorCode) : false;
  if (temporary && row) await app.jobs.scheduleResend(s.waMessageId, 5);
  await app.tg.notify(`WhatsApp send failed (code ${s.errorCode ?? '?'}: ${s.errorTitle ?? 'unknown'}) to +${s.recipient ?? '?'}.${temporary ? ' Retrying once.' : ' Not retrying.'}`);
}

async function handleHistory(_app: App, h: HistoryMessage): Promise<void> {
  const contact = await upsertContact(h.customer);
  const conv = await getOrCreateConversation(contact.id);
  await insertMessage({
    conversationId: conv.id, waMessageId: h.waMessageId, direction: h.fromBusiness ? 'echo' : 'in', author: h.fromBusiness ? 'human' : 'customer',
    type: h.type, text: h.text ?? (h.type === 'text' ? null : `[${h.type}]`), synced: true, createdAt: h.timestamp,
  });
}
