import type { Contact } from '../db/repo.js';
import type { TgButton } from './telegram.js';

export function handoffButtonsForDraft(draftId: string, contact: Contact): TgButton[][] {
  return [[
    { text: '👍', callback_data: `draft_up:${draftId}` },
    { text: '👎', callback_data: `draft_down:${draftId}` },
    { text: 'Open chat', url: `https://wa.me/${contact.wa_id}` },
  ]];
}
