import type { App } from '../app.js';
import type { ContentBlock, MessageParam, SystemBlock } from '../brain/claude.js';
import { textOf } from '../brain/claude.js';
import { buildConversation } from '../brain/conversation.js';
import { PROMPT_ADDENDUM, SYSTEM_PROMPT_V2, renderDynamic, renderKnowledge } from '../brain/prompt.js';
import { TOOLS, executeTool, type TurnState } from '../brain/tools.js';
import {
  botGreetedWithin, cancelFollowups, clearReplyDueUnlessNewer, countNewInboundSince, createDraft, createFollowup, getContact, getConversation, getLead,
  markGreeted, pendingInbound, saveAlertRef, setBotMode, setLeadSourceIfEmpty, setPendingPlan, kvGet, kvSet,
  type Contact, type Conversation, type MessageRow, type PendingPlan,
} from '../db/repo.js';
import { query } from '../db/client.js';
import { parseReplyOutput, interleavePhotos, type Bubble, type ReplyOutput } from './bubbles.js';
import { cleanText, cleanupBubbles, containsEmoji } from './cleanup.js';
import { findBanned, stripBannedSentences } from './banned.js';
import { classifyAck, ackReaction, isOptOut } from './quiet.js';
import { planDelays } from './pacing.js';
import { sendBubble, sendReaction } from './sender.js';
import { commitHandoff, replyByFor } from './handoff.js';
import { describeHours, isOpenNow } from './hours.js';
import { formatDateTimeIst } from './time.js';
import { effectiveMode } from './mode.js';
import { handoffButtonsForDraft } from '../team/drafts.js';

const GREETING_START = /^\s*(hi|hello|hey|namaste|namaskar)\b/i;

/** Entry point of the "reply" job. Safe to call any number of times: stale calls do nothing. */
export async function runReply(app: App, conversationId: string): Promise<void> {
  // Mutual exclusion per chat is provided by the customer's Durable Object (timers run one at a time).
  await runLocked(app, conversationId);
}

async function runLocked(app: App, conversationId: string): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return;
  const contact = (await getContact(conv.contact_id))!;
  const now = app.now();
  const claimedAt = new Date(now.getTime() + 1000);
  const brain = app.brain.get();
  const settings = brain.settings;
  const hours = app.brain.getHours();

  // 1. Resume a half-sent reply after a restart (bubbles already sent are never repeated).
  if (conv.pending_plan) {
    const plan = conv.pending_plan;
    const age = now.getTime() - new Date(plan.createdAt).getTime();
    const newer = await countNewInboundSince(conv.id, await lastInboundIdBefore(conv.id, new Date(plan.createdAt)));
    if (age < 5 * 60_000 && newer === 0) {
      await deliver(app, conv, contact, plan, await latestInboundId(conv.id), claimedAt);
      return;
    }
    await setPendingPlan(conv.id, null);
  }

  // 2. Is there anything due? (stale jobs from earlier messages exit here)
  if (!conv.reply_due_at) return;
  if (conv.reply_due_at.getTime() > now.getTime() + 1000) return;

  const mode = effectiveMode({ conversationMode: conv.bot_mode, settings, hours, now });
  if (mode === 'human' || mode === 'off' || contact.opted_out || contact.muted) {
    await clearDue(conv.id, claimedAt);
    return;
  }
  const pending = await pendingInbound(conv.id);
  if (!pending.length) { await clearDue(conv.id, claimedAt); return; }
  const shadow = mode === 'shadow';
  const lastPending = pending[pending.length - 1]!;
  const seenId = lastPending.id;
  const customerText = pending.map((m) => m.text ?? `[${m.type}]`).join(' / ');

  // 3. Opt-out
  if (pending.some((m) => m.type === 'text' && m.text && isOptOut(m.text))) {
    await optOut(app, conv, contact, shadow, claimedAt);
    return;
  }

  // 4. Voice notes (phase 1): acknowledge honestly and hand off
  if (pending.some((m) => m.type === 'audio')) {
    await voiceNote(app, conv, contact, pending, shadow, claimedAt);
    return;
  }

  // 5. Acknowledgements get a reaction, never a paragraph and never a question
  const allText = pending.every((m) => m.type === 'text' && m.text);
  if (allText) {
    const kind = classifyAck(pending.map((m) => m.text!));
    if (kind) {
      const emoji = ackReaction(pending.map((m) => m.text!));
      if (shadow) await postShadowDraft(app, conv, contact, customerText, [], emoji, []);
      else await sendReaction(app, conv, contact, lastPending.wa_message_id, emoji).catch((e) => console.warn('[reply] ack reaction failed', e.message));
      await clearDue(conv.id, claimedAt);
      return;
    }
  }

  // 6. Tell the team if the sheet is missing a product the website sent someone to
  const built = await buildConversation(app, conv, contact, pending);
  if (built.enquireMissingHandle) await alertMissingRow(app, built.enquireMissingHandle);
  for (const m of pending) if (m.referral) await setLeadSourceIfEmpty(contact.id, `ad:${(m.referral as any).headline ?? (m.referral as any).source_id ?? 'ctwa'}`);

  // 7. Read + typing (only when a reply will follow, and never in shadow mode)
  const stopTyping = shadow ? () => {} : startTyping(app, lastPending.wa_message_id);
  const interimTimer = shadow ? null : setTimeout(async () => {
    try { await sendBubble(app, conv, contact, { kind: 'text', text: 'One sec, checking that.' }, { interim: true }); } catch { /* cosmetic */ }
  }, 8000);

  let draft: ReplyOutput | null = null;
  const turn: TurnState = { photos: [], handoff: null, shadow };
  try {
    const lead = await getLead(contact.id);
    const dynamic = renderDynamic({
      nowIst: formatDateTimeIst(now), hoursText: describeHours(hours), isOpen: isOpenNow(hours, now), lead: leadView(contact, lead, conv), extra: built.extraContext,
    });
    const system: SystemBlock[] = [
      { type: 'text', text: `${SYSTEM_PROMPT_V2}\n\n${PROMPT_ADDENDUM}\n\nKNOWLEDGE BASE:\n${renderKnowledge(brain)}`, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamic },
    ];
    draft = await generateDraft(app, { conv, contact, system, messages: built.messages, turn });
  } catch (e) {
    clearTimeout(interimTimer ?? undefined); stopTyping();
    console.error('[reply] Claude failed', (e as Error).stack ?? (e as Error).message);
    await failSafe(app, conv, contact, shadow, claimedAt, (e as Error).message);
    return;
  }
  clearTimeout(interimTimer ?? undefined);

  // 8. A newer message arrived while Claude was writing: throw the draft away.
  //    The newer message re-armed the batch timer, so the next job answers everything together.
  if ((await countNewInboundSince(conv.id, seenId)) > 0) { stopTyping(); return; }

  // 9. Clean-up pass, banned-phrase rewrite
  const alreadyGreeted = await botGreetedWithin(conv.id, 24);
  const texts = await finalizeTexts(app, draft.messages, { customerUsedEmoji: built.customerUsedEmoji, alreadyGreeted }, conv.id);
  const photos = turn.photos.map((p) => ({ url: p.url, caption: cleanText(p.caption, { customerUsedEmoji: built.customerUsedEmoji }) }));
  const replyAlias = draft.reply_to ? built.aliases.get(draft.reply_to) ?? (pending.some((m) => m.wa_message_id === draft!.reply_to) ? draft.reply_to : null) : null;
  const replyTo = pending.length > 1 ? replyAlias : null;
  const bubbles = interleavePhotos(texts, photos, replyTo);
  const react = draft.react;

  if (shadow) {
    stopTyping();
    await postShadowDraft(app, conv, contact, customerText, texts, react, photos.map((p) => p.url));
    if (turn.handoff) await commitHandoff(app, conv, contact, turn.handoff, { shadow: true });
    await clearDue(conv.id, claimedAt);
    return;
  }

  const plan: PendingPlan = { createdAt: now.toISOString(), sent: 0, bubbles, react, reactTo: lastPending.wa_message_id };
  await setPendingPlan(conv.id, plan);
  if (draft.messages[0] && GREETING_START.test(draft.messages[0])) await markGreeted(conv.id);
  await deliver(app, conv, contact, plan, seenId, claimedAt, { stopTyping, turn });
}

async function clearDue(conversationId: string, claimedAt: Date) { await clearReplyDueUnlessNewer(conversationId, claimedAt); }

async function latestInboundId(conversationId: string): Promise<number> {
  const r = await query<{ id: string | null }>(`select max(id) id from messages where conversation_id = $1 and direction = 'in' and synced = false`, [conversationId]);
  return Number(r[0]?.id ?? 0);
}

async function lastInboundIdBefore(conversationId: string, at: Date): Promise<number> {
  const r = await query<{ id: string | null }>(`select max(id) id from messages where conversation_id = $1 and direction = 'in' and created_at <= $2`, [conversationId, at]);
  return Number(r[0]?.id ?? 0);
}

function leadView(contact: Contact, lead: Awaited<ReturnType<typeof getLead>>, conv: Conversation) {
  return {
    name: contact.name, language: contact.language, returning_customer: contact.first_seen < new Date(Date.now() - 6 * 3_600_000),
    first_seen: contact.first_seen, lead: lead ? { type: lead.type, firm: lead.firm, city: lead.city, products: lead.products, project_type: lead.project_type, quantity: lead.quantity, timeline: lead.timeline, budget: lead.budget, source: lead.source, status: lead.status, summary: lead.summary } : null,
    bot_greeted_recently: !!conv.greeted_at && conv.greeted_at > new Date(Date.now() - 24 * 3_600_000),
  };
}

function startTyping(app: App, waMessageId: string): () => void {
  void app.wa.markReadTyping(waMessageId, true);
  const t = setInterval(() => void app.wa.markReadTyping(waMessageId, true), 20_000); // indicator lapses after 25s
  return () => clearInterval(t);
}

// ---------------------------------------------------------------- Claude
async function generateDraft(app: App, a: { conv: Conversation; contact: Contact; system: SystemBlock[]; messages: MessageParam[]; turn: TurnState }): Promise<ReplyOutput> {
  // retry once, then Haiku, then give up (caller handles the fail-safe)
  const attempts = [app.claude.mainModel, app.claude.mainModel, app.claude.fastModel];
  let lastErr: unknown;
  for (const model of attempts) {
    a.turn.photos = []; a.turn.handoff = null;
    try { return await runToolLoop(app, model, a); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function runToolLoop(app: App, model: string, a: { conv: Conversation; contact: Contact; system: SystemBlock[]; messages: MessageParam[]; turn: TurnState }): Promise<ReplyOutput> {
  const messages: MessageParam[] = [...a.messages];
  let repaired = false;
  for (let i = 0; i < 6; i++) {
    const msg = await app.claude.call({ model, system: a.system, messages, tools: TOOLS, purpose: 'reply', conversationId: a.conv.id, maxTokens: 1500 });
    if (msg.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: msg.content as ContentBlock[] });
      const results: ContentBlock[] = [];
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue;
        const r = await executeTool(app, { conv: a.conv, contact: a.contact, turn: a.turn }, b.name, b.input);
        results.push({ type: 'tool_result', tool_use_id: b.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const out = parseReplyOutput(textOf(msg));
    if (out) return out;
    if (repaired) throw new Error('model did not return the JSON reply object');
    repaired = true;
    messages.push({ role: 'assistant', content: msg.content as ContentBlock[] });
    messages.push({ role: 'user', content: 'Return only the JSON object described under OUTPUT, nothing else.' });
  }
  throw new Error('tool loop did not finish');
}

async function haikuRewrite(app: App, bubble: string, phrases: string[], conversationId: string): Promise<string | null> {
  try {
    const msg = await app.claude.call({
      model: app.claude.fastModel, purpose: 'style_check', conversationId, maxTokens: 400,
      system: 'You edit short WhatsApp messages from a small furniture studio. Rewrite the message so it keeps the same facts and meaning but does not use any of the banned words or phrases. Plain, short, warm, no markdown, no lists, no em dashes. Return only the rewritten message.',
      messages: [{ role: 'user', content: `Banned: ${phrases.join(', ')}\n\nMessage:\n${bubble}` }],
    });
    return textOf(msg).trim() || null;
  } catch { return null; }
}

async function finalizeTexts(app: App, raw: string[], ctx: { customerUsedEmoji: boolean; alreadyGreeted: boolean }, conversationId: string): Promise<string[]> {
  const { bubbles, banned } = cleanupBubbles(raw, ctx);
  const out: string[] = [];
  for (let i = 0; i < bubbles.length; i++) {
    let b = bubbles[i]!;
    if (banned[i]!.length) {
      const rewritten = await haikuRewrite(app, b, banned[i]!, conversationId); // once
      const cleaned = rewritten ? cleanText(rewritten, ctx) : null;
      b = cleaned && findBanned(cleaned).length === 0 ? cleaned : stripBannedSentences(b); // plain version without the phrase
    }
    if (b.trim()) out.push(b.trim());
  }
  return out;
}

// ---------------------------------------------------------------- delivery
async function deliver(app: App, conv: Conversation, contact: Contact, plan: PendingPlan, seenId: number, claimedAt: Date, extra: { stopTyping?: () => void; turn?: TurnState } = {}): Promise<void> {
  const settings = app.brain.get().settings;
  const stop = extra.stopTyping ?? (() => {});
  const delays = planDelays(plan.bubbles.map((b) => (b.kind === 'text' ? b.text : b.caption)), settings, app.rand);
  const typingTarget = plan.reactTo;
  try {
    for (let i = plan.sent; i < plan.bubbles.length; i++) {
      if ((await countNewInboundSince(conv.id, seenId)) > 0) { await setPendingPlan(conv.id, null); return; } // customer typed more: stop, next job handles it
      if (typingTarget) void app.wa.markReadTyping(typingTarget, true);
      await app.sleep(delays[i]! * 1000);
      if ((await countNewInboundSince(conv.id, seenId)) > 0) { await setPendingPlan(conv.id, null); return; }
      await sendBubble(app, conv, contact, plan.bubbles[i]!);
      plan.sent = i + 1;
      await setPendingPlan(conv.id, plan);
    }
    if (plan.react && plan.reactTo) await sendReaction(app, conv, contact, plan.reactTo, plan.react).catch(() => undefined);
  } finally { stop(); }

  await setPendingPlan(conv.id, null);
  if (extra.turn?.handoff) await commitHandoff(app, conv, contact, extra.turn.handoff, { shadow: false });
  else await bookFollowup(app, conv, contact);
  await clearDue(conv.id, claimedAt);
}

async function bookFollowup(app: App, conv: Conversation, contact: Contact): Promise<void> {
  const s = app.brain.get().settings;
  if (!s.followupTemplate || !contact.followup_consent || contact.opted_out) return; // needs approved template + clear opt-in
  await cancelFollowups(conv.id, 'rebooked');
  const due = new Date(app.now().getTime() + s.followupDays * 86_400_000);
  const row = await createFollowup(conv.id, s.followupTemplate, due);
  if (row) await app.jobs.scheduleFollowup(contact.wa_id, row.id, due);
}

// ---------------------------------------------------------------- special paths
async function optOut(app: App, conv: Conversation, contact: Contact, shadow: boolean, claimedAt: Date) {
  await query('update contacts set opted_out = true where id = $1', [contact.id]);
  await cancelFollowups(conv.id, 'opted_out');
  if (shadow) await app.tg.notify(`(shadow) +${contact.wa_id} opted out. The bot would confirm once and never message again.`);
  else {
    await sendBubble(app, conv, contact, { kind: 'text', text: "Done, I won't message you again." }).catch((e) => console.error(e));
    await app.tg.notify(`+${contact.wa_id}${contact.name ? ` (${contact.name})` : ''} opted out. Bot will not message them again. /optin ${contact.wa_id} reverses it.`);
  }
  await clearDue(conv.id, claimedAt);
}

async function voiceNote(app: App, conv: Conversation, contact: Contact, pending: MessageRow[], shadow: boolean, claimedAt: Date) {
  const rb = replyByFor(app);
  const line = `Got your voice note, passing it to the team. They'll reply here by ${rb.text}.`;
  const lead = await getLead(contact.id);
  const summary = [`${contact.name ?? '+' + contact.wa_id}${lead?.firm ? `, ${lead.firm}` : ''}`, 'Sent a voice note (not transcribed yet)', `Promised a reply by ${rb.text}`].join('\n');
  if (shadow) await app.tg.notify(`(shadow) would reply: ${line}`);
  else {
    await app.wa.markReadTyping(pending[pending.length - 1]!.wa_message_id, true);
    await app.sleep(2500);
    await sendBubble(app, conv, contact, { kind: 'text', text: line });
  }
  await commitHandoff(app, conv, contact, { reason: 'voice note', urgency: 'normal', summary, replyBy: rb.date }, { shadow });
  await clearDue(conv.id, claimedAt);
}

/** Claude (and Haiku) failed: one honest line, human mode, Telegram alert. */
async function failSafe(app: App, conv: Conversation, contact: Contact, shadow: boolean, claimedAt: Date, err: string) {
  if (!shadow) {
    await sendBubble(app, conv, contact, { kind: 'text', text: 'Give me a few minutes on this one.' }).catch(() => undefined);
    await setBotMode(conv.id, 'human', 'bot_error');
  }
  const rb = replyByFor(app);
  await commitHandoff(app, conv, contact, { reason: 'bot error', urgency: 'normal', summary: `The assistant could not answer (${err.slice(0, 120)}).\nPlease reply to ${contact.name ?? '+' + contact.wa_id} directly.`, replyBy: rb.date }, { shadow });
  await clearDue(conv.id, claimedAt);
}

async function alertMissingRow(app: App, handle: string) {
  const key = `missing_row:${handle}:${app.now().toISOString().slice(0, 10)}`;
  if (await kvGet(key)) return;
  await kvSet(key, true);
  await app.tg.notify(`Brain sheet is missing a row for "${handle}". A customer enquired about it on the website. Add it to Products (website handle column).`);
}

async function postShadowDraft(app: App, conv: Conversation, contact: Contact, customerText: string, texts: string[], react: string | null, photoUrls: string[]) {
  const who = contact.name ?? `+${contact.wa_id}`;
  const draft = await createDraft(conv.id, { texts, react, photoUrls }, customerText);
  const body = texts.length || photoUrls.length
    ? [...texts, ...photoUrls.map(() => '[photo]')].join('  |  ')
    : react ? `(no text, reaction ${react})` : '(stays quiet)';
  const id = await app.tg.send(`Draft · ${who}\nCustomer: ${customerText.slice(0, 500)}\nBot: ${body}${react && texts.length ? `  +${react}` : ''}`, handoffButtonsForDraft(draft!.id, contact));
  await saveAlertRef(app.tg.chatId, id, conv.id, { draftId: draft!.id });
}
