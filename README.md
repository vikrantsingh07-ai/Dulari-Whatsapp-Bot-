# Dulari WhatsApp Agent

A WhatsApp agent for Dulari Design that replies the way the studio team would, answers product questions from a Google Sheet Akash controls, and hands hot leads to a human with a summary. Built from `docs/Dulari_WhatsApp_Agent_Build_Spec.pdf`.

```
Customer -> Meta Cloud API -> Hono webhook -> Postgres (messages, jobs via pg-boss)
                                   |
        reply job: lock chat -> load history + lead + Brain sheet -> read/typing -> Claude (tools)
                   -> clean-up pass -> paced bubbles -> store -> update lead -> Telegram alert on handoff
```

## What is implemented

| Area | Where |
|---|---|
| Webhook: signature check, dedupe on message id, 200 in <2s, echo (team typed on phone) and status handling | `src/webhook`, `src/whatsapp` |
| The 15 "feel human" rules: 8s batching capped at 25s, read + typing, typing pace with jitter, 1-3 short bubbles, language mirroring, quiet on "ok/thanks", memory, one photo not a list, quoted replies, honest "one sec", real hours and promises, clean-up pass (markdown, dashes, prices as Rs. 1,25,000, banned phrases with a Haiku rewrite), honest about being an assistant, silent in human mode | `src/engine`, `src/brain/prompt.ts` |
| Bot modes `auto / human / shadow / off`, kill switch, 48h human timeout (trade/project stay human) | `src/engine/mode.ts` |
| Claude Sonnet 5.5 with tools `lookup_product`, `send_product_photo`, `update_lead`, `handoff`; retry once, then Haiku 5.5, then an honest line + human mode + alert | `src/brain`, `src/engine/reply.ts` |
| Brain sheet sync every 10 min with row-level validation, last-good snapshot kept, errors posted to Telegram | `src/brain/parse.ts`, `store.ts` |
| Handoff alerts with Open chat / Take / Release / Snooze, 30-minute repeat, "promise kept" holding line, 9:30 digest, `/take /release /shadow /note /status /forget /optin` | `src/team`, `src/engine/proactive.ts` |
| Leads mirrored from Postgres to the "Dulari Leads" sheet every 5 min | `src/leads` |
| Day-2 follow-up templates (only with recorded consent), opt-out ("stop"), 12-month retention, `/forget` | `src/engine/proactive.ts` |
| Replay harness: scripted chats from the spec checked for wrong facts, banned phrases, bubble length, question count | `test/replay` |

## Setup

1. Do Phase 0 of the spec (accounts 1-8, fill the Brain sheet with the tabs `Products`, `FAQ`, `Policies`, `Settings`, `Team`).
2. `cp .env.example .env` and fill it. Local dev must use Meta's **test number** (`WHATSAPP_IS_TEST_NUMBER=true`).
3. `npm install`, then `npm run migrate` (also runs on boot), then `npm run dev`.
4. In the Meta app, set the webhook to `PUBLIC_URL/webhook` with your `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages` (and, after coexistence onboarding, `smb_message_echoes`, `history`).
5. The Telegram webhook is registered on boot when `PUBLIC_URL` is set (or `npm run set-webhooks`). Put the bot in the "Dulari Leads" group and set `TELEGRAM_CHAT_ID`.
6. Deploy to Railway or Render (always-on, Singapore or Mumbai). Start command: `npm start`.

## Brain sheet columns

- **Products**: `name`, `website handle`, `other names`, `price`, `size`, `woods`, `finishes`, `lead time`, `in stock`, `photo urls`, `product url`, `notes`, `active`
- **FAQ**: `question`, `answer`
- **Policies**: `topic`, `text` (or one row with the topics as headers)
- **Settings** (`key`, `value`): `studio_hours` (e.g. `Mon-Sat 10:00-19:00`), `holidays` (YYYY-MM-DD list), `handoff_reply_hours`, `batch_seconds`, `batch_max_seconds`, `typing_ms_per_char`, `human_mode_timeout_hours`, `BOT_ENABLED`, `SHADOW_MODE`, `shadow_during_studio_hours`, `followup_template`, `followup_days`, ...
- **Team**: `name`, `telegram handle`, `role`, `on duty`

## Tests

```bash
npm test                       # unit tests (engine, parsing, hours, checks)
TEST_DATABASE_URL=postgresql://... npm test   # + 20 integration tests against real Postgres with fake WhatsApp/Telegram/Claude
ANTHROPIC_API_KEY=... TEST_DATABASE_URL=... npm run replay -- --runs 3   # scripted chats against the real model
```

See `docs/NOTES.md` for what has and has not been verified, and deviations from the spec.
