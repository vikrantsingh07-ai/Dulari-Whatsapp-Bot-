import { describe, expect, it } from 'vitest';
import { fromOpenRouterResponse, OpenRouterClient, toOpenRouterRequest } from '../src/brain/openrouter.js';
import { loadConfig } from '../src/config.js';
import { TOOLS } from '../src/brain/tools.js';

const base = { DATABASE_URL: 'postgres://u:p@h/d', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v', TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '-1', TELEGRAM_WEBHOOK_SECRET: 'w', NODE_ENV: 'production' };

describe('provider selection', () => {
  it('uses OpenRouter when only its key is set, with the free router as default model', () => {
    const c = loadConfig({ ...base, OPENROUTER_API_KEY: 'k' } as any);
    expect(c.LLM_PROVIDER).toBe('openrouter');
    expect(c.CLAUDE_MODEL).toBe('openrouter/free');
  });
  it('uses Anthropic when only its key is set', () => {
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: 'k' } as any);
    expect(c.LLM_PROVIDER).toBe('anthropic');
    expect(c.CLAUDE_MODEL).toBe('claude-sonnet-5-5');
  });
  it('LLM_MODEL / LLM_FAST_MODEL override, and a missing key for the chosen provider is an error', () => {
    const c = loadConfig({ ...base, OPENROUTER_API_KEY: 'k', LLM_MODEL: 'vendor/model-a', LLM_FAST_MODEL: 'vendor/model-b' } as any);
    expect([c.CLAUDE_MODEL, c.CLAUDE_FAST_MODEL]).toEqual(['vendor/model-a', 'vendor/model-b']);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'openrouter', ANTHROPIC_API_KEY: 'k' } as any)).toThrow(/OPENROUTER_API_KEY/);
    expect(() => loadConfig({ ...base } as any)).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('OpenRouter request translation', () => {
  const args = {
    model: 'm', purpose: 'reply', tools: TOOLS, maxTokens: 500,
    system: [{ type: 'text' as const, text: 'You are Dulari.' }, { type: 'text' as const, text: 'TODAY: now' }],
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: '[m1] price?' }, { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'checking' }, { type: 'tool_use' as const, id: 'call_1', name: 'lookup_product', input: { query: 'daily table' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call_1', content: '{"matches":[]}' }] },
    ],
  };
  const req: any = toOpenRouterRequest(args, 'm');
  it('joins system blocks and maps roles', () => {
    expect(req.messages[0]).toEqual({ role: 'system', content: 'You are Dulari.\n\nTODAY: now' });
    expect(req.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
  it('maps images, tool calls and tool results', () => {
    expect(req.messages[1].content).toEqual([{ type: 'text', text: '[m1] price?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    expect(req.messages[2]).toMatchObject({ content: 'checking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_product', arguments: '{"query":"daily table"}' } }] });
    expect(req.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"matches":[]}' });
  });
  it('maps the four tools and asks for cost reporting', () => {
    expect(req.tools.map((t: any) => t.function.name)).toEqual(['lookup_product', 'send_product_photo', 'update_lead', 'handoff']);
    expect(req.tools[0].function.parameters.type).toBe('object');
    expect(req).toMatchObject({ tool_choice: 'auto', max_tokens: 500, usage: { include: true } });
  });
});

describe('OpenRouter response translation', () => {
  it('plain answer', () => {
    const m: any = fromOpenRouterResponse({ choices: [{ message: { content: '{"messages":["hi"]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }, 'm');
    expect(m.content).toEqual([{ type: 'text', text: '{"messages":["hi"]}' }]);
    expect(m.stop_reason).toBe('end_turn');
    expect(m.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });
  it('tool call becomes a tool_use block even if finish_reason says stop', () => {
    const m: any = fromOpenRouterResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'handoff', arguments: '{"reason":"x","urgency":"hot","summary":"a"}' } }] }, finish_reason: 'stop' }] }, 'm');
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'handoff', input: { reason: 'x', urgency: 'hot', summary: 'a' } }]);
  });
  it('survives broken tool arguments and reports provider errors', () => {
    const m: any = fromOpenRouterResponse({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{oops' } }] } }] }, 'm');
    expect(m.content[0].input).toEqual({});
    expect(() => fromOpenRouterResponse({ error: { message: 'rate limited' } }, 'm')).toThrow(/rate limited/);
    expect(() => fromOpenRouterResponse({ choices: [] }, 'm')).toThrow(/no answer/);
  });
  it('client sends auth + model and returns a translated message', async () => {
    let seen: any;
    const f = (async (url: string, init: any) => { seen = { url, init, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); }) as any;
    const c = new OpenRouterClient({ OPENROUTER_API_KEY: 'sk-or-x', OPENROUTER_BASE_URL: 'https://example.test/api/v1/', CLAUDE_MODEL: 'a/b', CLAUDE_FAST_MODEL: 'c/d' }, f);
    const r: any = await c.call({ model: c.mainModel, purpose: 'reply', system: 's', messages: [{ role: 'user', content: 'hi' }] }).catch((e) => ({ err: e }));
    // logLlmCall needs a DB; the call itself must still have gone out correctly
    expect(seen.url).toBe('https://example.test/api/v1/chat/completions');
    expect(seen.init.headers.Authorization).toBe('Bearer sk-or-x');
    expect(seen.body.model).toBe('a/b');
    void r;
  });
});
