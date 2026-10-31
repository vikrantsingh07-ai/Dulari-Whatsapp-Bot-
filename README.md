# Dulari WhatsApp Agent

A WhatsApp agent for Dulari Design that replies the way the studio team would, answers product questions from a Google Sheet Akash controls, and hands hot leads to a human with a summary. Built from `docs/Dulari_WhatsApp_Agent_Build_Spec.pdf`.

```
Customer -> Meta Cloud API -> Cloudflare Worker (Hono) -> Postgres via Hyperdrive (Supabase, Mumbai)
                                   |
                       per-customer Durable Object  (timers, one job at a time = the per-chat lock)
                                   |
   alarm: load history + lead + Brain sheet -> read/typing -> Claude (tools) -> clean-up pass
          -> paced bubbles -> store -> update lead -> Telegram alert on handoff

Cron Trigger (every minute): overdue-reply sweep, alert repeats, Leads sheet mirror, Brain re-sync, health, digest, retention
Vercel: small status dashboard that reads the Worker's /admin/status
```

## What is implemented

| Area | Where |
|---|---|
| Webhook: signature check, dedupe on message id, 200 in <2s (work continues via `waitUntil`), echo (team typed on phone) and status handling | `src/webhook`, `src/whatsapp` |
| The 15 "feel human" rules: 8s batching capped at 25s, read + typing, typing pace with jitter, 1-3 short bubbles, language mirroring, quiet on "ok/thanks", memory, one photo not a list, quoted replies, honest "one sec", real hours and promises, clean-up pass (markdown, dashes, prices as Rs. 1,25,000, banned phrases with a Haiku rewrite), honest about being an assistant, silent in human mode | `src/engine`, `src/brain/prompt.ts` |
| Bot modes `auto / human / shadow / off`, kill switch, 48h human timeout (trade/project stay human) | `src/engine/mode.ts` |
| Claude Sonnet 5.5 with tools `lookup_product`, `send_product_photo`, `update_lead`, `handoff`; retry once, then Haiku 5.5, then an honest line + human mode + alert | `src/brain`, `src/engine/reply.ts` |
| Brain sheet sync every 10 min with row-level validation, last-good snapshot kept, errors posted to Telegram | `src/brain/parse.ts`, `store.ts` |
| Handoff alerts with Open chat / Take / Release / Snooze, 30-minute repeat, "promise kept" holding line, 9:30 digest, `/take /release /shadow /note /status /forget /optin` | `src/team`, `src/engine/proactive.ts` |
| Leads mirrored from Postgres to the "Dulari Leads" sheet every 5 min | `src/leads` |
| Cloudflare Worker, per-customer Durable Object timers, cron, Hyperdrive; Vercel status dashboard | `src/worker*`, `wrangler.jsonc`, `dashboard/` |
| Day-2 follow-up templates (only with recorded consent), opt-out ("stop"), 12-month retention, `/forget` | `src/engine/proactive.ts` |
| Replay harness: scripted chats from the spec checked for wrong facts, banned phrases, bubble length, question count | `test/replay` |

## Deploy (Cloudflare Workers + Vercel)

Everything runs on **free tiers** (see `docs/NOTES.md`, "Running on free tiers"): Cloudflare Workers Free (SQLite-backed Durable Objects, cron and Hyperdrive are all included), Supabase Free, Vercel Hobby. The only unavoidable cost is Claude API usage, billed per message. Do Phase 0 of the spec first (Meta app + system-user token, Brain and Leads sheets with a Google service account, Telegram bot and group, Anthropic key with a monthly spend cap).

```bash
npm install
npx wrangler login
```

1. **Database.** Create the Supabase project (Mumbai), then apply the schema once from your machine:
   ```bash
   DATABASE_URL="postgres://..." npm run migrate
   ```
2. **Hyperdrive.** `npx wrangler hyperdrive create dulari-db --connection-string="postgres://..."`, then paste the returned id into `wrangler.jsonc` (`REPLACE_WITH_HYPERDRIVE_ID`).
3. **Secrets** (each prompts for the value, never put them in git):
   ```bash
   for s in WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN ANTHROPIC_API_KEY \
            BRAIN_SHEET_ID LEADS_SHEET_ID GOOGLE_SERVICE_ACCOUNT_JSON TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID \
            TELEGRAM_WEBHOOK_SECRET ADMIN_TOKEN; do npx wrangler secret put $s; done
   # optional: SHOPIFY_SHOP_DOMAIN SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET DASHBOARD_ORIGIN PRICE_*_PER_MTOK
   ```
4. **Deploy:** `npm run deploy`. Put the resulting `https://dulari-whatsapp-agent.<you>.workers.dev` into `PUBLIC_URL` in `wrangler.jsonc` and deploy again.
5. **Webhooks.** In the Meta app: callback URL `PUBLIC_URL/webhook` with your verify token, subscribe to `messages` (and, after coexistence onboarding, `smb_message_echoes` and `history`). Telegram: `PUBLIC_URL=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... TELEGRAM_WEBHOOK_SECRET=... npm run set-webhooks`.
6. **Dashboard (free).** `cd dashboard && npx vercel --prod` (Vercel Hobby is meant for non-commercial use, so for a business you may prefer Cloudflare Pages: `npx wrangler pages deploy dashboard`), open it, paste the Worker URL and `ADMIN_TOKEN`. Set `DASHBOARD_ORIGIN` (Worker secret) to the Vercel URL so the browser may call the Worker.
7. **Go-live switch** is in the Brain sheet Settings tab: `SHADOW_MODE` (default TRUE = drafts to Telegram only) and `BOT_ENABLED`. `WHATSAPP_IS_TEST_NUMBER` in `wrangler.jsonc` stays `"true"` until the real number is onboarded (phase 3).

Local development: copy `.dev.vars.example` to `.dev.vars`, point `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` at a local Postgres (the URL needs a password), run `npm run dev`. Use Meta's **test number** locally.

## Brain sheet columns

- **Products**: `name`, `website handle`, `other names`, `price`, `size`, `woods`, `finishes`, `lead time`, `in stock`, `photo urls`, `product url`, `notes`, `active`
- **FAQ**: `question`, `answer`
- **Policies**: `topic`, `text` (or one row with the topics as headers)
- **Settings** (`key`, `value`): `studio_hours` (e.g. `Mon-Sat 10:00-19:00`), `holidays` (YYYY-MM-DD list), `handoff_reply_hours`, `batch_seconds`, `batch_max_seconds`, `typing_ms_per_char`, `human_mode_timeout_hours`, `BOT_ENABLED`, `SHADOW_MODE`, `shadow_during_studio_hours`, `followup_template`, `followup_days`, ...
- **Team**: `name`, `telegram handle`, `role`, `on duty`

## Tests

```bash
npm test                                                  # 46 unit tests (engine, parsing, hours, replay checks)
TEST_DATABASE_URL=postgresql://... npm test               # + 20 integration tests: real Postgres, fake WhatsApp/Telegram/Claude
TEST_DATABASE_URL=postgres://user:pw@127.0.0.1:5432/db npm run e2e   # 15 checks through the real Workers runtime (workerd) with mock servers
ANTHROPIC_API_KEY=... TEST_DATABASE_URL=... npm run replay -- --runs 3   # scripted chats against the real model
npm run typecheck && npm run build                        # tsc --strict, and a wrangler bundle dry run
```

See `docs/NOTES.md` for what has and has not been verified, and deviations from the spec.
