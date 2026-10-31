import type { Config } from '../config.js';

export class WhatsAppError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly temporary = false) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Meta error codes that are worth one more try (rate limit / transient). */
export const TEMPORARY_ERROR_CODES = new Set(['130429', '131016', '131000', '133016', '80007']);

export class WhatsAppClient {
  private base: string;
  constructor(private cfg: Pick<Config, 'WHATSAPP_TOKEN' | 'WHATSAPP_PHONE_NUMBER_ID' | 'WHATSAPP_API_VERSION'> & { WHATSAPP_API_BASE?: string }, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.base = `${cfg.WHATSAPP_API_BASE ?? 'https://graph.facebook.com'}/${cfg.WHATSAPP_API_VERSION}`;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}, tries = 3): Promise<any> {
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, {
          method: init.method ?? (init.body ? 'POST' : 'GET'),
          headers: { Authorization: `Bearer ${this.cfg.WHATSAPP_TOKEN}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const json: any = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const code = json?.error?.code as number | undefined;
        const temporary = res.status === 429 || res.status >= 500 || TEMPORARY_ERROR_CODES.has(String(code));
        const err = new WhatsAppError(json?.error?.message ?? `HTTP ${res.status}`, res.status, code, temporary);
        if (!temporary) throw err;
        lastErr = err;
      } catch (e) {
        if (e instanceof WhatsAppError && !e.temporary) throw e;
        lastErr = e;
      }
      await sleep(500 * 2 ** i);
    }
    throw lastErr;
  }

  private msgPath = () => `/${this.cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private firstId = (j: any): string => {
    const id = j?.messages?.[0]?.id;
    if (!id) throw new WhatsAppError('No message id in response', 200);
    return id;
  };

  async sendText(to: string, body: string, replyToWaId?: string | null): Promise<string> {
    return this.firstId(await this.call(this.msgPath(), { body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false },
      ...(replyToWaId ? { context: { message_id: replyToWaId } } : {}),
    } }));
  }
  async sendImage(to: string, link: string, caption: string): Promise<string> {
    return this.firstId(await this.call(this.msgPath(), { body: { messaging_product: 'whatsapp', to, type: 'image', image: { link, caption } } }));
  }
  async sendReaction(to: string, messageId: string, emoji: string): Promise<string | null> {
    const j = await this.call(this.msgPath(), { body: { messaging_product: 'whatsapp', to, type: 'reaction', reaction: { message_id: messageId, emoji } } });
    return j?.messages?.[0]?.id ?? null;
  }
  async sendTemplate(to: string, name: string, languageCode: string, bodyParams: string[]): Promise<string> {
    return this.firstId(await this.call(this.msgPath(), { body: {
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: languageCode }, ...(bodyParams.length ? { components: [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }] } : {}) },
    } }));
  }
  /** Marks the message read and (optionally) shows the typing indicator. Never throws: cosmetic. */
  async markReadTyping(messageId: string, typing = true): Promise<void> {
    try {
      await this.call(this.msgPath(), { body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) } }, 1);
    } catch (e) { console.warn('[wa] markReadTyping failed', (e as Error).message); }
  }
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const meta = await this.call(`/${mediaId}`);
    const res = await this.fetchImpl(meta.url, { headers: { Authorization: `Bearer ${this.cfg.WHATSAPP_TOKEN}` } });
    if (!res.ok) throw new WhatsAppError(`media download HTTP ${res.status}`, res.status, undefined, res.status >= 500);
    return { data: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream' };
  }
  /** Health probe used by the 15-minute check. */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const j = await this.call(`/${this.cfg.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`, {}, 1);
      return { ok: true, detail: `${j.display_phone_number ?? ''} quality=${j.quality_rating ?? '?'}` };
    } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}
