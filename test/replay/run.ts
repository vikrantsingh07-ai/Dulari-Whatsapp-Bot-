/**
 * Replay harness. Runs scripted chats against the REAL Claude API (fake WhatsApp/Telegram, real Postgres)
 * and checks every reply automatically.
 *
 *   TEST_DATABASE_URL=... ANTHROPIC_API_KEY=... npm run replay -- --runs 3 [--only "architect"]
 *
 * Gate from the spec: every scripted test passes 3 runs in a row. Costs real API money (low).
 */
import { ClaudeClient } from '../../src/brain/claude.js';
import { makeApp, inbound, setupDb, teardownDb, DB_URL } from '../integration/harness.js';
import { query } from '../../src/db/client.js';
import { handleInbound } from '../../src/webhook/ingest.js';
import { runReply } from '../../src/engine/reply.js';
import { getConversationByContactWa } from '../../src/db/repo.js';
import { checkTurn } from './checks.js';
import { SCENARIOS } from './scenarios.js';
import { parseBrain } from '../../src/brain/parse.js';
import { goodTables } from '../integration/harness.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 1;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;

if (!DB_URL) throw new Error('Set TEST_DATABASE_URL (a throwaway Postgres)');
if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY');

const WA = '919999900001';
await setupDb();

const tables = process.env.REPLAY_BRAIN_JSON
  ? (() => { const j = JSON.parse(readFileSync(process.env.REPLAY_BRAIN_JSON!, 'utf8')); return { products: j.Products, faq: j.FAQ, policies: j.Policies, settings: j.Settings, team: j.Team }; })()
  : goodTables;
if (!parseBrain(tables).brain) throw new Error('replay brain does not validate');

let failed = 0;
for (let run = 1; run <= runs; run++) {
  for (const sc of SCENARIOS.filter((s) => !only || s.name.includes(only))) {
    await query('truncate contacts cascade');
    const t = makeApp();
    (t.app as any).claude = new ClaudeClient({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? 'claude-sonnet-5-5', CLAUDE_FAST_MODEL: process.env.CLAUDE_FAST_MODEL ?? 'claude-haiku-5-5' } as any);
    if (sc.at) t.clock.offset = new Date(sc.at).getTime() - Date.now();
    const problems: string[] = [];
    for (const [i, turn] of sc.turns.entries()) {
      const before = { sent: t.sent.length, tg: t.tgMessages.length };
      for (const say of turn.say) { await handleInbound(t.app, inbound(say)); t.clock.advance(1500); }
      t.clock.advance(9000);
      const conv = (await getConversationByContactWa(WA))!;
      await runReply(t.app, conv.id);
      const sent = t.sent.slice(before.sent);
      const handedOff = t.tgMessages.slice(before.tg).some((m) => /Handoff|HOT/.test(m.text));
      const fails = checkTurn({
        texts: sent.filter((s) => s.kind === 'text').map((s) => s.body!),
        photos: sent.filter((s) => s.kind === 'image').length,
        reaction: sent.find((s) => s.kind === 'reaction')?.emoji ?? null,
        handedOff,
      }, t.brain, turn.expect);
      if (fails.length) problems.push(`turn ${i + 1} (${turn.say.join(' / ').slice(0, 50)}): ${fails.join('; ')}\n      sent: ${JSON.stringify(sent.filter((s) => s.kind !== 'read').map((s) => s.body ?? s.emoji))}`);
    }
    console.log(`${problems.length ? 'FAIL' : 'pass'}  run ${run}  ${sc.name}`);
    for (const p of problems) console.log(`   - ${p}`);
    if (problems.length) failed++;
  }
}
await teardownDb();
console.log(failed ? `\n${failed} scenario run(s) failed` : '\nall scenario runs passed');
process.exit(failed ? 1 : 0);
