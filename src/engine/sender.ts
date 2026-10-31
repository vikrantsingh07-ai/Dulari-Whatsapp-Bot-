import type { App } from '../app.js';
import type { Contact, Conversation } from '../db/repo.js';
import { insertMessage } from '../db/repo.js';
import type { Bubble } from './bubbles.js';

/** Sends one bubble through WhatsApp and records it (store immediately so restarts never repeat it). */
export async function sendBubble(app: App, conv: Conversation, contact: Contact, bubble: Bubble, opts: { interim?: boolean } = {}): Promise<string> {
  const id = bubble.kind === 'text'
    ? await app.wa.sendText(contact.wa_id, bubble.text, bubble.replyTo)
    : await app.wa.sendImage(contact.wa_id, bubble.url, bubble.caption);
  await insertMessage({
    conversationId: conv.id, waMessageId: id, direction: 'out', author: 'bot',
    type: opts.interim ? 'interim' : bubble.kind === 'text' ? 'text' : 'image',
    text: bubble.kind === 'text' ? bubble.text : bubble.caption, quotedId: bubble.kind === 'text' ? bubble.replyTo ?? null : null, status: 'sent',
  });
  return id;
}

export async function sendReaction(app: App, conv: Conversation, contact: Contact, toWaMessageId: string, emoji: string): Promise<void> {
  const id = await app.wa.sendReaction(contact.wa_id, toWaMessageId, emoji);
  if (id) await insertMessage({ conversationId: conv.id, waMessageId: id, direction: 'out', author: 'bot', type: 'reaction', text: emoji, status: 'sent' });
}
