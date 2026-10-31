import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import { logLlmCall } from '../db/repo.js';

export type ContentBlock = Anthropic.Messages.ContentBlockParam;
export type MessageParam = Anthropic.Messages.MessageParam;
export type ToolDef = Anthropic.Messages.Tool;
export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

export interface CallArgs {
  model: string;
  system: SystemBlock[] | string;
  messages: MessageParam[];
  tools?: ToolDef[];
  maxTokens?: number;
  purpose: string;
  conversationId?: string | null;
}

export interface Pricing { inPerMtok?: number; outPerMtok?: number }

export class ClaudeClient {
  readonly mainModel: string;
  readonly fastModel: string;
  private sdk: Anthropic;
  constructor(private cfg: Config, sdk?: Anthropic) {
    this.mainModel = cfg.CLAUDE_MODEL;
    this.fastModel = cfg.CLAUDE_FAST_MODEL;
    // we do our own retry-then-fallback, so the SDK must not retry for long
    this.sdk = sdk ?? new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 40_000, maxRetries: 0, ...(cfg.ANTHROPIC_BASE_URL ? { baseURL: cfg.ANTHROPIC_BASE_URL } : {}) });
  }

  private price(model: string): Pricing {
    return model === this.mainModel
      ? { inPerMtok: this.cfg.PRICE_MAIN_IN_PER_MTOK, outPerMtok: this.cfg.PRICE_MAIN_OUT_PER_MTOK }
      : { inPerMtok: this.cfg.PRICE_FAST_IN_PER_MTOK, outPerMtok: this.cfg.PRICE_FAST_OUT_PER_MTOK };
  }

  /** One Messages API call, logged to llm_calls. Low effort: this is chat, latency matters. */
  async call(a: CallArgs): Promise<Anthropic.Messages.Message> {
    const started = Date.now();
    try {
      const params: any = {
        model: a.model,
        max_tokens: a.maxTokens ?? 1024,
        system: a.system,
        messages: a.messages,
        output_config: { effort: 'low' },
        ...(a.tools?.length ? { tools: a.tools, tool_choice: { type: 'auto' } } : {}),
      };
      const msg = (await this.sdk.messages.create(params)) as Anthropic.Messages.Message;
      if ((msg.stop_reason as string) === 'refusal') throw new Error('model refused the request');
      const u: any = msg.usage ?? {};
      const p = this.price(a.model);
      const cost = p.inPerMtok != null && p.outPerMtok != null
        ? ((u.input_tokens ?? 0) * p.inPerMtok + (u.output_tokens ?? 0) * p.outPerMtok) / 1e6 : null;
      await logLlmCall({
        conversationId: a.conversationId, purpose: a.purpose, model: a.model, inputTokens: u.input_tokens, outputTokens: u.output_tokens,
        cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, cost, latencyMs: Date.now() - started,
      }).catch(() => undefined);
      return msg;
    } catch (e) {
      await logLlmCall({ conversationId: a.conversationId, purpose: a.purpose, model: a.model, latencyMs: Date.now() - started, error: (e as Error).message }).catch(() => undefined);
      throw e;
    }
  }
}

export const textOf = (m: Anthropic.Messages.Message): string =>
  m.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
