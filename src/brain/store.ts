import type { Config } from '../config.js';
import { kvGet, kvSet, latestBrainSnapshot, saveBrainSnapshot } from '../db/repo.js';
import { parseBrain } from './parse.js';
import { SheetsClient } from './sheets.js';
import type { Brain } from './types.js';
import { parseStudioHours, type StudioHours } from '../engine/hours.js';
import sampleBrain from '../../fixtures/brain.sample.json' with { type: 'json' };

export const BRAIN_TABS = ['Products', 'FAQ', 'Policies', 'Settings', 'Team'] as const;
const REFRESH_MS = 10 * 60_000;

/**
 * Per-isolate cache of the Brain sheet. Workers isolates come and go, so every entry point calls
 * `ensure()`: it loads the last good snapshot from Postgres on a cold start and re-reads the sheet
 * when the cache is older than 10 minutes (cron also forces a sync). A bad edit never replaces the good copy.
 */
export class BrainStore {
  private brain: Brain | null = null;
  private hours: StudioHours | null = null;
  private lastAttempt = 0;
  lastSyncOk: Date | null = null;
  lastSyncError: string | null = null;

  constructor(
    private cfg: Pick<Config, 'BRAIN_SOURCE' | 'BRAIN_SHEET_ID' | 'GOOGLE_SERVICE_ACCOUNT_JSON'>,
    private alert: (text: string) => Promise<void>,
    private sheets: SheetsClient | null,
  ) {}

  get(): Brain {
    if (!this.brain) throw new Error('Brain not loaded');
    return this.brain;
  }
  isLoaded() { return this.brain !== null; }
  getHours(): StudioHours {
    const b = this.get();
    if (!this.hours || this.hours.raw !== b.settings.studioHours) this.hours = parseStudioHours(b.settings.studioHours, b.settings.holidays);
    return this.hours;
  }
  private set(b: Brain) { this.brain = b; this.hours = null; }

  async ensure(): Promise<void> {
    if (!this.brain) {
      const snap = await latestBrainSnapshot();
      if (snap) { this.set(snap.data as Brain); this.lastSyncOk = new Date(snap.created_at); }
    }
    if (!this.brain || Date.now() - this.lastAttempt > REFRESH_MS) await this.sync();
    if (!this.brain) throw new Error('Brain sheet failed to load and no earlier snapshot exists. Fix the sheet.');
  }

  async sync(): Promise<boolean> {
    this.lastAttempt = Date.now();
    try {
      const tables = await this.fetchTables();
      const res = parseBrain({ products: tables.Products, faq: tables.FAQ, policies: tables.Policies, settings: tables.Settings, team: tables.Team });
      if (!res.brain) { await this.reportErrors(res.errors); return false; }
      this.set(res.brain);
      await saveBrainSnapshot(res.brain);
      this.lastSyncOk = new Date();
      this.lastSyncError = null;
      await kvSet('brain_error_sig', '');
      return true;
    } catch (e) {
      await this.reportErrors([`Could not read the Brain sheet: ${(e as Error).message}`]);
      return false;
    }
  }

  private async fetchTables(): Promise<Record<string, string[][]>> {
    if (this.cfg.BRAIN_SOURCE === 'file') return sampleBrain as Record<string, string[][]>;
    if (!this.sheets || !this.cfg.BRAIN_SHEET_ID) throw new Error('BRAIN_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON not configured');
    return this.sheets.batchGet(this.cfg.BRAIN_SHEET_ID, [...BRAIN_TABS]);
  }

  private async reportErrors(errors: string[]) {
    this.lastSyncError = errors.join('; ');
    const sig = errors.join('|');
    if ((await kvGet<string>('brain_error_sig')) === sig) return; // don't repeat the same complaint every 10 minutes
    await kvSet('brain_error_sig', sig);
    const kept = this.brain ? 'Bot is still using the last good version.' : 'No earlier version exists, bot cannot start.';
    await this.alert(`Brain sheet problem. ${kept}\n${errors.slice(0, 15).map((e) => `- ${e}`).join('\n')}`);
  }
}
