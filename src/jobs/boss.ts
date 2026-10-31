import PgBoss from 'pg-boss';
import type { App } from '../app.js';
import type { EchoPayload, Jobs } from './types.js';
import { runReply } from '../engine/reply.js';
import { handleEcho } from '../webhook/ingest.js';
import {
  downloadMedia, expireHumanMode, healthCheck, mirrorLeads, morningDigest, repeatUnclaimedAlerts, resendFailed, retention, sendFollowup, sendHoldingLine, sweepOverdueReplies,
} from '../engine/proactive.js';

const Q = {
  reply: 'reply', echo: 'echo', media: 'media', followup: 'followup', holding: 'holding', resend: 'resend',
  sweep: 'cron-sweep', health: 'cron-health', digest: 'cron-digest', repeat: 'cron-repeat-alerts', humanTimeout: 'cron-human-timeout',
  mirror: 'cron-mirror', retention: 'cron-retention', brain: 'cron-brain-sync',
} as const;

export class PgBossJobs implements Jobs {
  readonly boss: PgBoss;
  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss', max: 6 });
    this.boss.on('error', (e) => console.error('[pg-boss]', e.message));
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const q of Object.values(Q)) await this.boss.createQueue(q);
  }

  // ---- Jobs interface
  async scheduleReply(conversationId: string, dueAt: Date) {
    await this.boss.send(Q.reply, { conversationId }, { startAfter: dueAt, retryLimit: 2, retryDelay: 5, expireInSeconds: 90 });
  }
  async scheduleEchoCheck(p: EchoPayload, delaySeconds: number) {
    await this.boss.send(Q.echo, p, { startAfter: delaySeconds, singletonKey: p.waMessageId, retryLimit: 3, retryDelay: 3 });
  }
  async scheduleMediaDownload(mediaId: string) {
    await this.boss.send(Q.media, { mediaId }, { singletonKey: mediaId, retryLimit: 4, retryDelay: 3, expireInSeconds: 120 });
  }
  async scheduleFollowup(followupId: string, dueAt: Date) {
    await this.boss.send(Q.followup, { followupId }, { startAfter: dueAt, singletonKey: followupId, retryLimit: 3, retryDelay: 60 });
  }
  async scheduleHolding(conversationId: string, delaySeconds: number) {
    await this.boss.send(Q.holding, { conversationId }, { startAfter: delaySeconds, singletonKey: `${conversationId}:${Math.floor(Date.now() / 60000)}`, retryLimit: 1 });
  }
  async scheduleResend(waMessageId: string, delaySeconds: number) {
    await this.boss.send(Q.resend, { waMessageId }, { startAfter: delaySeconds, singletonKey: waMessageId, retryLimit: 0 });
  }

  /** Register workers and recurring jobs once the App exists. */
  async register(app: App): Promise<void> {
    const w = <T extends object>(q: string, fn: (d: T) => Promise<void>, opts: PgBoss.WorkOptions = {}) =>
      this.boss.work<T>(q, { pollingIntervalSeconds: 1, ...opts }, async (jobs) => { for (const j of jobs) await fn(j.data); });

    await w<{ conversationId: string }>(Q.reply, (d) => runReply(app, d.conversationId));
    await w<EchoPayload>(Q.echo, (d) => handleEcho(app, d));
    await w<{ mediaId: string }>(Q.media, (d) => downloadMedia(app, d.mediaId));
    await w<{ followupId: string }>(Q.followup, (d) => sendFollowup(app, d.followupId));
    await w<{ conversationId: string }>(Q.holding, (d) => sendHoldingLine(app, d.conversationId));
    await w<{ waMessageId: string }>(Q.resend, (d) => resendFailed(app, d.waMessageId));

    const cron = async (q: string, expr: string, fn: () => Promise<void>) => {
      await this.boss.schedule(q, expr, {}, { tz: 'Asia/Kolkata' });
      await this.boss.work(q, { pollingIntervalSeconds: 5 }, async () => { try { await fn(); } catch (e) { console.error(`[${q}]`, (e as Error).message); } });
    };
    await cron(Q.sweep, '* * * * *', () => sweepOverdueReplies(app));
    await cron(Q.repeat, '*/5 * * * *', () => repeatUnclaimedAlerts(app));
    await cron(Q.health, '*/15 * * * *', () => healthCheck(app));
    await cron(Q.humanTimeout, '*/10 * * * *', () => expireHumanMode(app));
    await cron(Q.brain, '*/10 * * * *', async () => { await app.brain.sync(); });
    await cron(Q.mirror, '*/5 * * * *', () => mirrorLeads(app));
    await cron(Q.digest, '30 9 * * *', () => morningDigest(app));
    await cron(Q.retention, '15 3 * * *', () => retention(app));
  }

  async stop() { await this.boss.stop({ graceful: true, timeout: 15_000 }); }
}
