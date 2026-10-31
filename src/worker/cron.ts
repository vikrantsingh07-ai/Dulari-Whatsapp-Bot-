import type { App } from '../app.js';
import { expireHumanMode, healthCheck, mirrorLeads, morningDigest, repeatUnclaimedAlerts, retention, sweepOverdueReplies } from '../engine/proactive.js';

/**
 * One cron trigger, every minute (UTC). Everything recurring hangs off it, so the Worker needs a single trigger:
 *  every minute  re-queue overdue replies (safety net)
 *  every 5 min   repeat unclaimed alerts, mirror leads to the Leads sheet
 *  every 10 min  end expired human modes, re-read the Brain sheet
 *  every 15 min  WhatsApp health check
 *  04:00 UTC     09:30 IST morning digest
 *  21:45 UTC     03:15 IST retention
 */
export async function runCron(app: App, scheduledTime: number): Promise<void> {
  const d = new Date(scheduledTime);
  const min = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const step = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.error(`[cron:${name}]`, (e as Error).message); } };
  await step('sweep', () => sweepOverdueReplies(app));
  if (min % 5 === 0) { await step('repeat', () => repeatUnclaimedAlerts(app)); await step('mirror', () => mirrorLeads(app)); }
  if (min % 10 === 0) { await step('human-timeout', () => expireHumanMode(app)); await step('brain', () => app.brain.sync()); }
  if (min % 15 === 0) await step('health', () => healthCheck(app));
  if (hour === 4 && min === 0) await step('digest', () => morningDigest(app));
  if (hour === 21 && min === 45) await step('retention', () => retention(app));
}
