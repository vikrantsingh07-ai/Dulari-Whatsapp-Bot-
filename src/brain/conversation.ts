import type { App } from '../app.js';
import type { ContentBlock, MessageParam } from './claude.js';
import type { Contact, Conversation, MessageRow } from '../db/repo.js';
import { getMedia, getMessageByWaId, recentMessages, saveMedia } from '../db/repo.js';
import { containsEmoji } from '../engine/cleanup.js';
import { parseEnquire, findProducts } from './lookup.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_MEDIA_BYTES = 4_500_000;

export interface BuiltConversation {
  messages: MessageParam[];
  /** m1, m2... -> wa message id, for reply_to */
  aliases: Map<string, string>;
  customerUsedEmoji: boolean;
  extraContext: string[];
  enquireMissingHandle: string | null;
}

function describeNonText(m: MessageRow): string {
  switch (m.type) {
    case 'image': return `[photo]${m.text ? ' ' + m.text : ''}`;
    case 'document': return `[document ${m.filename ?? ''}]${m.text ? ' ' + m.text : ''}`;
    case 'video': return `[video, cannot be viewed]${m.text ? ' ' + m.text : ''}`;
    case 'audio': return m.transcript ? `[voice note] ${m.transcript}` : '[voice note]';
    case 'sticker': return '[sticker]';
    case 'location': return `[location pin] ${m.text ?? ''}`.trim();
    case 'reaction': return `[reacted ${m.text ?? ''}]`;
    default: return m.text ?? `[${m.type}]`;
  }
}

async function mediaBlock(app: App, m: MessageRow): Promise<ContentBlock | null> {
  if (!m.media_id) return null;
  const isImage = m.type === 'image' && (!m.mime_type || IMAGE_TYPES.has(m.mime_type));
  const isPdf = m.type === 'document' && m.mime_type === 'application/pdf';
  if (!isImage && !isPdf) return null;
  let row = await getMedia(m.media_id);
  if (!row) {
    try {
      const d = await app.wa.downloadMedia(m.media_id);
      await saveMedia(m.media_id, d.mime, d.data);
      row = { media_id: m.media_id, mime_type: d.mime, data: d.data };
    } catch { return null; }
  }
  if (row.data.length > MAX_MEDIA_BYTES) return null;
  const data = row.data.toString('base64');
  if (isPdf) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const mt = (IMAGE_TYPES.has(row.mime_type) ? row.mime_type : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  return { type: 'image', source: { type: 'base64', media_type: mt, data } };
}

/**
 * Last 30 messages as an Anthropic transcript. Customer messages in the pending batch get
 * ids m1, m2... so Claude can quote-reply to the right one.
 */
export async function buildConversation(app: App, conv: Conversation, contact: Contact, pending: MessageRow[]): Promise<BuiltConversation> {
  const history = await recentMessages(conv.id, 30);
  const pendingIds = new Set(pending.map((p) => p.id));
  const aliases = new Map<string, string>();
  const extra: string[] = [];
  let n = 0;
  let customerUsedEmoji = false;
  let imagesAttached = 0;

  const turns: { role: 'user' | 'assistant'; blocks: ContentBlock[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks: [...blocks] });
  };

  for (const m of history) {
    if (m.direction === 'in') {
      if (m.text && containsEmoji(m.text)) customerUsedEmoji = true;
      let line = describeNonText(m);
      if (pendingIds.has(m.id)) {
        const alias = `m${++n}`;
        aliases.set(alias, m.wa_message_id);
        line = `[${alias}] ${line}`;
        if (m.quoted_id) {
          const q = await getMessageByWaId(m.quoted_id);
          if (q?.text) line += ` (replying to: "${q.text.slice(0, 120)}")`;
        }
      }
      const blocks: ContentBlock[] = [{ type: 'text', text: line }];
      if (pendingIds.has(m.id) && imagesAttached < 3) {
        const mb = await mediaBlock(app, m);
        if (mb) { blocks.push(mb); imagesAttached++; }
      }
      push('user', blocks);
    } else if (m.type === 'reaction' || m.type === 'interim') {
      continue;
    } else {
      const text = m.type === 'image' ? `[photo sent] ${m.text ?? ''}`.trim() : m.text ?? `[${m.type}]`;
      push('assistant', [{ type: 'text', text: m.direction === 'echo' ? `(typed by the team from their phone) ${text}` : text }]);
    }
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  if (!turns.length || turns[turns.length - 1]!.role !== 'user') throw new Error('conversation has no trailing customer message');

  // Context lines from the pending batch
  let enquireMissingHandle: string | null = null;
  for (const m of pending) {
    if (m.referral) {
      const r = m.referral as Record<string, string>;
      extra.push(`The customer came from a click-to-WhatsApp ad${r.headline ? ` (headline: "${r.headline}")` : ''}${r.body ? ` (ad text: "${r.body}")` : ''}. Open on the product the ad is about. Never mention the ad.`);
    }
    if (m.type === 'text' && m.text) {
      const enq = parseEnquire(m.text);
      if (enq) {
        const brain = app.brain.get();
        const found = enq.handle
          ? brain.products.find((p) => p.active && p.handle === enq.handle) ?? null
          : findProducts(enq.productText, brain.products, 1)[0]?.product ?? null;
        if (found) extra.push(`The Enquire message is about ${found.name} (handle ${found.handle}). Use lookup_product with that handle.`);
        else {
          enquireMissingHandle = enq.handle ?? enq.productText;
          extra.push(`The product they enquired about ("${enq.productText}"${enq.url ? `, ${enq.url}` : ''}) is not in the sheet. Share the link, say the price is being checked, and call handoff with reason catalog_missing.`);
        }
      }
    }
  }
  if (contact.language) extra.push(`Customer's language so far: ${contact.language}.`);

  return {
    messages: turns.map((t) => ({ role: t.role, content: t.blocks })),
    aliases, customerUsedEmoji, extraContext: extra, enquireMissingHandle,
  };
}
