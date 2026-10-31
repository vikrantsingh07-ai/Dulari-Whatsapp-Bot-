# Build notes

## Verified in this repo
- `tsc --strict` clean; 65 tests pass (45 unit, 20 integration on a real Postgres 16 with fake WhatsApp / Telegram / Claude).
- Integration tests cover: burst batching + early-job no-op, duplicate webhook, ack -> reaction without calling Claude, echo -> human mode and silence, bot's own echo ignored, handoff end to end (lead + alert + reply-by), draft discarded when a new message lands mid-generation, Haiku banned-phrase rewrite and plain fallback, shadow mode, Claude failure chain, opt-out, kill switch, voice note, photo ordering, restart resume without repeats, holding line, human-mode timeout, follow-up consent, Telegram commands.

## NOT verified (no credentials or network access to these services in the build environment)
Nothing below has been run against the live service. Check each in the Meta test number / a scratch Telegram group before Phase 3:
1. **Real model output.** The replay harness (`npm run replay`) has not been run: it needs `ANTHROPIC_API_KEY`. Prompt v2 is verbatim from the spec; expect to iterate it against the harness. The Claude client sends `output_config: {effort: "low"}` and no thinking config (chat latency); confirm both models accept it, or remove it in `src/brain/claude.ts`.
2. **Coexistence webhook shapes.** Team replies from the phone are read from the `smb_message_echoes` field (`message_echoes[]` with `to`, `id`, `text.body`) and history sync from `history` (`history[].threads[].messages[]`). Both parsers are in `src/whatsapp/events.ts` and are written from memory of Meta's docs; the spec says to check current docs. Log a real payload during onboarding and adjust. Echoes are processed 3s late on purpose so the bot's own sends (stored first) are ignored.
3. **Typing indicator.** Sent as `status: "read"` + `typing_indicator: {type: "text"}` per Gupshup's description of the Cloud API. `markReadTyping` never throws, so a wrong payload degrades silently to "no typing".
4. **Google Sheets, Shopify, Telegram calls** are plain REST and typed-checked but untested live. Shopify uses the client-credentials token endpoint and `productByHandle` GraphQL (API version `2025-10`, bump if needed). Sheet photo URLs take priority, so Shopify is optional.
5. Meta error codes treated as temporary (`src/whatsapp/client.ts`): 130429, 131016, 131000, 133016, 80007. Review against Meta's list.

## Deviations and judgement calls
- **Debounce state lives in `conversations.reply_due_at`**; pg-boss carries the delayed jobs. Each inbound enqueues a job at its due time; stale jobs see a later due time and exit. A per-minute sweep re-queues any overdue reply whose job was lost. This keeps "reset the 8s timer, cap 25s" exact.
- **Newer message while Claude writes**: the draft (and its side effects: photos, handoff) is discarded and the next job, already re-armed 8s out, answers everything together.
- **Handoff side effects are applied after the bubbles are sent**, never from a discarded draft.
- **`SHADOW_MODE` defaults to TRUE** (also when the Settings row is missing) so nothing reaches a customer by accident. Set it to FALSE in the sheet to go live.
- **Haiku is used only for the banned-phrase rewrite** (the spec also mentions summaries; handoff summaries are written by Sonnet in the `handoff` tool instead).
- **Follow-ups never send without recorded consent** (`contacts.followup_consent`, set with `/optin <number>` after the customer clearly agrees) and an approved template name in Settings (`followup_template`). Nothing is booked otherwise. India's DPDP rules and WhatsApp policy are the reason.
- **Opted-out contacts**: the bot is silent from then on. `/optin` reverses it.
- The unspecified bubble-placement rule: a photo goes before the closing question bubble, so the question stays last.
- The "One sec, checking that." line is sent only if Claude has genuinely been running 8s.
- The prompt addendum (`PROMPT_ADDENDUM` in `src/brain/prompt.ts`) is not in the spec's v2 text: it encodes the edge-case table rows (message ids, PDFs, photos, complaints, ad context, missing catalog rows). Keep it short and review it.

## Not built yet (from the spec)
- Voice-note transcription (Phase 2 after launch). Voice notes get the honest line + hot-normal handoff.
- Abuse/spam auto-mute after 3 messages (the `muted` flag exists; nothing sets it yet).
- Instagram DMs, weekly review tooling, template packaging.
- Submitting the 4 follow-up templates to Meta (done in WhatsApp Manager).
- Ongoing human steps: coexistence onboarding of +91 88514 72382, token rotation after the dev finishes, answering the spec's open questions (hours, handoff owner, trade pricing policy, delivery outside NCR, kids' set, first-message disclosure, retention).
