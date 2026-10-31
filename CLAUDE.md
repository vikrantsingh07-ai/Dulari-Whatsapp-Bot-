# CLAUDE.md
Project: Dulari WhatsApp agent. Spec: docs/Dulari_WhatsApp_Agent_Build_Spec.pdf (export to docs/spec.md when convenient). Voice and tests: see "Voice and scripts" in the spec.
Stack: TypeScript (strict), Cloudflare Workers + Durable Objects + Cron + Hyperdrive, Hono, Postgres (Supabase), Anthropic SDK, Vitest. Dashboard on Vercel (dashboard/, plain HTML).
Layout: src/webhook (verify, store, dedupe, schedule), src/engine (batching, pacing, bubbles, cleanup, reply orchestration), src/brain (prompt, tools, sheet sync, Claude client),
        src/whatsapp (Cloud API client + event parsing), src/team (Telegram alerts + commands), src/jobs (Jobs interface), src/worker (Worker entry, ChatDO Durable Object, cron), src/leads (Leads sheet mirror), test/ (unit, integration, replay).
Rules:
- Never hard-code secrets or phone numbers; read from env.
- Every engine rule in the spec section "Making it feel human" is a pure function with unit tests (src/engine/*).
- Settings come from the Brain sheet (src/brain/parse.ts), not constants. DEFAULT_SETTINGS are only fallbacks. SHADOW_MODE defaults to TRUE.
- Webhook handler acks in under 2s; slow work happens in the customer's Durable Object (timers). Everything touching Postgres runs inside `withDb(...)` on Workers.
- Never send to the real number from local dev; use the Meta test number (config.ts refuses to start otherwise).
- Workers constraints: no Node-only libs (fs, google-auth-library, pg-boss), no shared I/O across requests, no session-level Postgres locks. Check `npm run build` (wrangler dry run) and `npm run e2e` after touching src/worker, src/db/client.ts or anything imported by them.
- Run `npm test` before every commit. Integration tests need TEST_DATABASE_URL (a throwaway Postgres); they skip without it.
- Small commits, one task each.
