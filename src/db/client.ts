import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

/**
 * Two modes, same `query()` API:
 *  - Cloudflare Workers: every invocation runs inside `withDb(connectionString, fn)` and gets its own
 *    connection (Hyperdrive pools underneath). Workers must not share I/O objects across requests.
 *  - Node (tests, migrations, scripts): a normal global Pool.
 */
interface Ctx { connectionString: string; client?: pg.Client; connecting?: Promise<pg.Client> }
const als = new AsyncLocalStorage<Ctx>();

let pool: pg.Pool | undefined;
export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: connectionString ?? process.env.DATABASE_URL, max: 10 });
    pool.on('error', (e) => console.error('[pg] idle client error', e.message));
  }
  return pool;
}

export async function withDb<T>(connectionString: string, fn: () => Promise<T>): Promise<T> {
  const ctx: Ctx = { connectionString };
  try {
    return await als.run(ctx, fn);
  } finally {
    const c = ctx.client;
    ctx.client = undefined;
    if (c) await c.end().catch(() => undefined);
  }
}

async function ctxClient(ctx: Ctx): Promise<pg.Client> {
  if (ctx.client) return ctx.client;
  ctx.connecting ??= (async () => {
    const c = new pg.Client({ connectionString: ctx.connectionString });
    c.on('error', () => { if (ctx.client === c) ctx.client = undefined; });
    await c.connect();
    ctx.client = c;
    return c;
  })().finally(() => { ctx.connecting = undefined; });
  return ctx.connecting;
}

const isConnError = (e: unknown) => /terminated|ECONNRESET|57P01|Connection closed|not queryable/i.test(String((e as Error)?.message ?? e) + String((e as any)?.code ?? ''));

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const ctx = als.getStore();
  if (!ctx) return (await getPool().query<T>(text, params as any[])).rows;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await (await ctxClient(ctx)).query<T>(text, params as any[])).rows;
    } catch (e) {
      if (attempt === 0 && isConnError(e)) { ctx.client = undefined; continue; } // long alarms can outlive an idle connection
      throw e;
    }
  }
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await query<T>(text, params))[0] ?? null;
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}
