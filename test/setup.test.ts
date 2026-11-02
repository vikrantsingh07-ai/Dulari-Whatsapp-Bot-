import { describe, expect, it } from 'vitest';
import { currentHyperdriveId, extractSheetId, fillPassword, looksLikePostgres, needsPassword, parseHyperdriveId, parseWorkerUrl, patchHyperdriveId, pickGroupChatId, patchVar, randomToken } from '../scripts/setup-lib.js';
import { readFileSync } from 'node:fs';
import { listSubscribed, subscribeWaba } from '../scripts/subscribe-waba-lib.js';

describe('setup helpers', () => {
  it('extracts a sheet id from a link or bare id', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBc';
    expect(extractSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(extractSheetId(id)).toBe(id);
    expect(extractSheetId('not a link')).toBeNull();
  });
  it('fills the Supabase password placeholder with URL encoding', () => {
    const u = 'postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
    expect(needsPassword(u)).toBe(true);
    expect(fillPassword(u, 'p@ss/w:rd')).toContain(':p%40ss%2Fw%3Ard@');
    expect(looksLikePostgres(fillPassword(u, 'x'))).toBe(true);
    expect(looksLikePostgres('hello')).toBe(false);
  });
  it('reads and patches the Hyperdrive id', () => {
    const src = readFileSync('wrangler.jsonc', 'utf8');
    expect(currentHyperdriveId(src)).toBeNull();
    const id = 'a'.repeat(32);
    const patched = patchHyperdriveId(src, id);
    expect(currentHyperdriveId(patched)).toBe(id);
    expect(patched).not.toContain('REPLACE_WITH_HYPERDRIVE_ID');
    expect(parseHyperdriveId(`✅ Created new Hyperdrive config: {\n "id": "${id}",\n "name": "dulari-db"\n}`)).toBe(id);
    expect(parseHyperdriveId(`│ ${id} │ dulari-db │`, 'dulari-db')).toBe(id);
  });
  it('finds the worker url and the telegram group', () => {
    expect(parseWorkerUrl('Deployed dulari-whatsapp-agent triggers\n  https://dulari-whatsapp-agent.me.workers.dev\nCurrent Version ID')).toBe('https://dulari-whatsapp-agent.me.workers.dev');
    const deployOutput = `Your Worker has access to the following bindings:\nenv.PUBLIC_URL ("https://REPLACE.workers.dev")   Environment Variable\nTotal Upload: 2240 KiB\nUploaded dulari-whatsapp-agent (3.1 sec)\nDeployed dulari-whatsapp-agent triggers (1.0 sec)\n  https://dulari-whatsapp-agent.jarvis-1.workers.dev\n  schedule: * * * * *`;
    expect(parseWorkerUrl(deployOutput)).toBe('https://dulari-whatsapp-agent.jarvis-1.workers.dev');
    expect(parseWorkerUrl('only https://REPLACE.workers.dev here')).toBeNull();
    expect(pickGroupChatId({ result: [{ message: { chat: { id: 5, type: 'private' } } }, { message: { chat: { id: -1001234, type: 'supergroup', title: 'Dulari Leads' } } }] })).toEqual({ id: '-1001234', title: 'Dulari Leads' });
    expect(pickGroupChatId({ result: [] })).toBeNull();
  });
  it('patches wrangler vars', () => {
    const src = readFileSync('wrangler.jsonc', 'utf8');
    const out = patchVar(patchVar(src, 'LLM_PROVIDER', 'anthropic'), 'LLM_MODEL', 'claude-sonnet-5-5');
    expect(out).toContain('"LLM_PROVIDER": "anthropic"');
    expect(out).toContain('"LLM_MODEL": "claude-sonnet-5-5"');
    expect(out).toContain('"LLM_FAST_MODEL": "openrouter/free"');
    expect(() => patchVar(src, 'NOPE', 'x')).toThrow();
  });
  it('makes long random tokens', () => { expect(randomToken()).toHaveLength(48); expect(randomToken()).not.toBe(randomToken()); });

  it('subscribes the app to the WhatsApp account and shows before/after', async () => {
    const calls: string[] = [];
    let subscribed = false;
    const f = (async (url: string, init: any) => {
      calls.push(`${init.method} ${url.split('/').slice(-2).join('/')} ${init.headers.Authorization}`);
      if (init.method === 'POST') { subscribed = true; return new Response(JSON.stringify({ success: true }), { status: 200 }); }
      return new Response(JSON.stringify({ data: subscribed ? [{ whatsapp_business_api_data: { id: '1', name: 'Dulari Bot' } }] : [] }), { status: 200 });
    }) as any;
    const r = await subscribeWaba(f, 'tok', '2194934211366490');
    expect(r.before).toEqual([]);
    expect(r.after).toEqual([{ name: 'Dulari Bot', id: '1', override: undefined }]);
    expect(r.success).toBe(true);
    expect(calls).toEqual(['GET 2194934211366490/subscribed_apps Bearer tok', 'POST 2194934211366490/subscribed_apps Bearer tok', 'GET 2194934211366490/subscribed_apps Bearer tok']);
    const bad = (async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 400 })) as any;
    await expect(listSubscribed(bad, 'x', 'w')).rejects.toThrow(/Invalid OAuth/);
  });
});
