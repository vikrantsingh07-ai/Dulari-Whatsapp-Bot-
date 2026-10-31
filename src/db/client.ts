import pg from 'pg';

let pool: pg.Pool | undefined;

export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: connectionString ?? process.env.DATABASE_URL, max: 10 });
    pool.on('error', (e) => console.error('[pg] idle client error', e.message));
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await getPool().query<T>(text, params as any[]);
  return r.rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await query<T>(text, params))[0] ?? null;
}

/**
 * Per-conversation lock (spec: "one lock per conversation; the second waits").
 * Holds a session-level advisory lock on a dedicated connection for the duration of `fn`.
 * Returns null if the lock is held elsewhere.
 */
export async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await getPool().connect();
  try {
    const got = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [conversationId]);
    if (!got.rows[0]?.ok) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [conversationId]);
    }
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}
