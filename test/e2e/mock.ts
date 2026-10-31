import { createServer, type Server } from 'node:http';

export interface MockCalls { wa: any[]; tg: any[]; llm: any[] }

/** One tiny server pretending to be Meta Graph, Telegram and the Anthropic API. */
export function startMock(port: number): Promise<{ server: Server; calls: MockCalls }> {
  const calls: MockCalls = { wa: [], tg: [], llm: [] };
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : null;
      const json = (o: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.startsWith('/__calls')) return json(calls);
      if (url.startsWith('/api/v1/chat/completions')) {
        calls.llm.push(body);
        const text = JSON.stringify({ messages: ['The Daily Table is Rs 9500, solid wood.', 'Which city is it for?'], react: null, reply_to: null });
        return json({ id: 'gen-mock', model: body?.model ?? 'mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 } });
      }
      if (url.startsWith('/v1/messages')) {
        calls.llm.push(body);
        const text = JSON.stringify({ messages: ['The Daily Table is Rs 9500, solid wood.', 'Which city is it for?'], react: null, reply_to: null });
        return json({ id: 'msg_mock', type: 'message', role: 'assistant', model: body?.model ?? 'mock', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
      }
      if (/^\/v[\d.]+\/[^/]+\/messages/.test(url)) { calls.wa.push(body); return json({ messages: [{ id: `wamid.MOCK${++seq}` }] }); }
      if (/^\/v[\d.]+\//.test(url)) return json({ display_phone_number: '+91 88514 72382', quality_rating: 'GREEN' });
      if (url.startsWith('/bot')) { calls.tg.push({ method: url.split('/').pop(), body }); return json({ ok: true, result: { message_id: 5000 + ++seq } }); }
      json({ error: 'mock: unknown route ' + url }, 404);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}
