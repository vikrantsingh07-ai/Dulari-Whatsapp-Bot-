import { query } from './db/client.js';
import type { App } from './app.js';
import { dayStats } from './db/repo.js';

/** Read-only numbers for the Vercel dashboard. Contains phone numbers: protected by ADMIN_TOKEN. */
export async function adminStatus(app: App) {
  const [stats, modes, handoffs, drafts, cost, calls] = await Promise.all([
    dayStats(),
    query<{ bot_mode: string; n: string }>('select bot_mode, count(*) n from conversations group by bot_mode'),
    query(`select k.wa_id, k.name, h.urgency, h.reason, h.created_at, h.due_at, h.claimed_by from handoffs h join conversations c on c.id = h.conversation_id join contacts k on k.id = c.contact_id where h.resolved_at is null order by h.created_at desc limit 25`),
    query<{ rating: string | null; n: string }>(`select rating, count(*) n from drafts where created_at > now() - interval '14 days' group by rating`),
    query<{ day: string; calls: string; cost: string | null; in_tokens: string; out_tokens: string; avg_ms: string }>(
      `select to_char(created_at at time zone 'Asia/Kolkata','YYYY-MM-DD') as day, count(*) calls, sum(cost) cost, coalesce(sum(input_tokens),0) in_tokens, coalesce(sum(output_tokens),0) out_tokens, coalesce(avg(latency_ms),0)::int avg_ms
       from llm_calls where created_at > now() - interval '7 days' group by 1 order by 1 desc`),
    query<{ errors: string }>(`select count(*) errors from llm_calls where error is not null and created_at > now() - interval '24 hours'`),
  ]);
  const s = app.brain.get().settings;
  return {
    generatedAt: new Date().toISOString(),
    numberMode: app.cfg.WHATSAPP_IS_TEST_NUMBER ? 'test' : 'real',
    settings: { botEnabled: s.botEnabled, shadowMode: s.shadowMode, studioHours: s.studioHours },
    brain: { products: app.brain.get().products.filter((p) => p.active).length, syncedAt: app.brain.lastSyncOk, problem: app.brain.lastSyncError },
    stats, modes, openHandoffs: handoffs, draftRatings: drafts, llm: cost, llmErrors24h: Number(calls[0]?.errors ?? 0),
  };
}
