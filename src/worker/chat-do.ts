import { DurableObject } from 'cloudflare:workers';
import type { App } from '../app.js';
import { runReply } from '../engine/reply.js';
import { handleEcho } from '../webhook/ingest.js';
import { downloadMedia, resendFailed, sendFollowup, sendHoldingLine } from '../engine/proactive.js';
import { buildApp, runDb } from './app.js';
import { DoJobs } from './jobs.js';
import type { Env } from './env.js';

export interface Timer {
  id: string;
  key?: string;
  kind: 'reply' | 'echo' | 'media' | 'followup' | 'holding' | 'resend';
  at: number;
  payload: any;
  attempts: number;
}
export type NewTimer = Omit<Timer, 'id' | 'attempts'>;

const MAX_ATTEMPTS = 4;

async function runTimer(app: App, t: Timer): Promise<void> {
  switch (t.kind) {
    case 'reply': return runReply(app, t.payload.conversationId);
    case 'echo': return handleEcho(app, t.payload);
    case 'media': return downloadMedia(app, t.payload.mediaId);
    case 'followup': return sendFollowup(app, t.payload.followupId);
    case 'holding': return sendHoldingLine(app, t.payload.conversationId);
    case 'resend': return resendFailed(app, t.payload.waMessageId);
  }
}

/**
 * One Durable Object per customer (named by wa_id). It is the "one lock per conversation":
 * timers run one at a time, so two reply jobs for one chat can never overlap. Timers live in
 * DO storage, so they survive restarts and deploys. The single alarm always points at the earliest timer.
 */
export class ChatDO extends DurableObject<Env> {
  private timers: Timer[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.timers = (await ctx.storage.get<Timer[]>('timers')) ?? []; });
  }

  /** RPC from the webhook / ingest. A timer with the same key replaces the old one (latest wins). */
  async schedule(t: NewTimer): Promise<void> {
    this.timers = this.timers.filter((x) => !(t.key && x.key === t.key));
    this.timers.push({ ...t, id: crypto.randomUUID(), attempts: 0 });
    await this.save();
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('timers', this.timers);
    if (this.timers.length) await this.ctx.storage.setAlarm(Math.min(...this.timers.map((t) => t.at)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
    if (due.length) {
      const app = buildApp(this.env, new DoJobs(this.env.CHAT));
      await runDb(this.env, app, async () => {
        for (const t of due) {
          try {
            await runTimer(app, t);
            this.timers = this.timers.filter((x) => x.id !== t.id);
          } catch (e) {
            console.error(`[chat-do] ${t.kind} failed (attempt ${t.attempts + 1})`, (e as Error).message);
            const cur = this.timers.find((x) => x.id === t.id);
            if (!cur) continue; // replaced by a newer timer meanwhile
            cur.attempts++;
            if (cur.attempts >= MAX_ATTEMPTS) {
              this.timers = this.timers.filter((x) => x.id !== t.id);
              await app.tg.notify(`A ${t.kind} job failed ${MAX_ATTEMPTS} times and was dropped: ${(e as Error).message.slice(0, 200)}`);
            } else cur.at = Date.now() + 5_000 * 2 ** cur.attempts; // backoff, then try again
          }
        }
      }).catch((e) => console.error('[chat-do] alarm setup failed', (e as Error).message));
      // if the DB/brain were unreachable, make sure due timers are retried instead of lost
      for (const t of this.timers) if (t.at <= Date.now() && due.some((d) => d.id === t.id) && t.attempts === 0) t.at = Date.now() + 10_000;
    }
    await this.save();
  }
}
