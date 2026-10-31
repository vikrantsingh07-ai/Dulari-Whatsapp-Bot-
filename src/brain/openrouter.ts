import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import type { CallArgs, LlmClient } from './claude.js';
import { logLlmCall } from '../db/repo.js';

/**
 * OpenRouter speaks the OpenAI "chat completions" format. The rest of the bot is written against
 * Anthropic-shaped messages and tool blocks, so this adapter translates both ways (pure functions below,
 * unit-tested) and returns an Anthropic-shaped Message. Nothing else in the code has to know.
 */

type AnyBlock = Record<string, any>;

function systemText(system: CallArgs['system']): string {
  return typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');
}

export function toOpenRouterRequest(args: CallArgs, model: string): Record<string, unknown> {
  const messages: any[] = [{ role: 'system', content: systemText(args.system) }];
  for (const m of args.messages) {
    const blocks: AnyBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as AnyBlock[]);
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become role "tool" messages, everything else one user message
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') });
    }
    const parts: any[] = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      else if (b.type === 'document' && b.source?.type === 'base64') parts.push({ type: 'file', file: { filename: 'document.pdf', file_data: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  return {
    model, messages, max_tokens: args.maxTokens ?? 1024,
    usage: { include: true }, // ask OpenRouter to report the real cost
    ...(args.tools?.length ? { tools: args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: 'auto' } : {}),
  };
}

export function fromOpenRouterResponse(json: any, model: string): Anthropic.Messages.Message {
  if (json?.error) throw new Error(`OpenRouter: ${json.error.message ?? JSON.stringify(json.error)}`);
  const choice = json?.choices?.[0];
  if (!choice?.message) throw new Error('OpenRouter returned no answer');
  const msg = choice.message;
  const content: AnyBlock[] = [];
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? '').join('') : '';
  if (text.trim()) content.push({ type: 'text', text });
  const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const c of calls) {
    let input: unknown = {};
    try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = {}; }
    content.push({ type: 'tool_use', id: c.id ?? `call_${content.length}`, name: c.function?.name, input });
  }
  const stop_reason = calls.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: json.id ?? 'or', type: 'message', role: 'assistant', model: json.model ?? model, content, stop_reason, stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
  } as unknown as Anthropic.Messages.Message;
}

export class OpenRouterClient implements LlmClient {
  readonly mainModel: string;
  readonly fastModel: string;
  private base: string;
  constructor(private cfg: Pick<Config, 'OPENROUTER_API_KEY' | 'OPENROUTER_BASE_URL' | 'CLAUDE_MODEL' | 'CLAUDE_FAST_MODEL'>, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    if (!cfg.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
    this.mainModel = cfg.CLAUDE_MODEL;
    this.fastModel = cfg.CLAUDE_FAST_MODEL;
    this.base = (cfg.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }

  async call(a: CallArgs): Promise<Anthropic.Messages.Message> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://dulari.design', 'X-Title': 'Dulari WhatsApp Agent' },
        body: JSON.stringify(toOpenRouterRequest(a, a.model)),
        signal: AbortSignal.timeout(40_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok && !json?.error) throw new Error(`OpenRouter HTTP ${res.status}`);
      const msg = fromOpenRouterResponse(json, a.model);
      await logLlmCall({
        conversationId: a.conversationId, purpose: a.purpose, model: a.model, inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens,
        cost: typeof json.usage?.cost === 'number' ? json.usage.cost : null, latencyMs: Date.now() - started,
      }).catch(() => undefined);
      return msg;
    } catch (e) {
      await logLlmCall({ conversationId: a.conversationId, purpose: a.purpose, model: a.model, latencyMs: Date.now() - started, error: (e as Error).message }).catch(() => undefined);
      throw e;
    }
  }
}
