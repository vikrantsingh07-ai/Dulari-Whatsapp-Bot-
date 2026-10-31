export interface TgButton { text: string; callback_data?: string; url?: string }

export class Telegram {
  constructor(private token: string, readonly chatId: string, private fetchImpl: typeof fetch = fetch) {}
  private async call<T = any>(method: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result as T;
  }
  /** Plain text on purpose (no parse_mode), so customer text can never break formatting. Returns message_id. */
  async send(text: string, buttons?: TgButton[][], replyTo?: number): Promise<number> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    });
    return r.message_id;
  }
  /** Never throws: alerting must not take the bot down. */
  async notify(text: string): Promise<void> {
    try { await this.send(text); } catch (e) { console.error('[telegram] notify failed', (e as Error).message); }
  }
  answerCallback(id: string, text?: string) { return this.call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => undefined); }
  clearButtons(messageId: number) { return this.call('editMessageReplyMarkup', { chat_id: this.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined); }
  setWebhook(url: string, secret: string) {
    return this.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
  }
}
