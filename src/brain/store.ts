import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { latestBrainSnapshot, saveBrainSnapshot } from '../db/repo.js';
import { parseBrain } from './parse.js';
import { SheetsClient } from './sheets.js';
import type { Brain } from './types.js';
import { parseStudioHours, type StudioHours } from '../engine/hours.js';

export const BRAIN_TABS = ['Products', 'FAQ', 'Policies', 'Settings', 'Team'] as const;

export class BrainStore {
  private brain: Brain | null = null;
  private hours: StudioHours | null = null;
  private lastErrorSig = '';
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

  /** Boot: use last good snapshot immediately, then try a fresh sync. */
  async start(): Promise<void> {
    const snap = await latestBrainSnapshot();
    if (snap) this.set(snap.data as Brain);
    await this.sync();
    if (!this.brain) throw new Error('Brain sheet failed to load and no earlier snapshot exists. Fix the sheet and restart.');
  }

  async sync(): Promise<boolean> {
    try {
      const tables = await this.fetchTables();
      const res = parseBrain({ products: tables.Products, faq: tables.FAQ, policies: tables.Policies, settings: tables.Settings, team: tables.Team });
      if (!res.brain) {
        await this.reportErrors(res.errors);
        return false;
      }
      this.set(res.brain);
      await saveBrainSnapshot(res.brain);
      this.lastSyncOk = new Date();
      this.lastSyncError = null;
      this.lastErrorSig = '';
      return true;
    } catch (e) {
      this.lastSyncError = (e as Error).message;
      await this.reportErrors([`Could not read the Brain sheet: ${(e as Error).message}`]);
      return false;
    }
  }

  private async fetchTables() {
    if (this.cfg.BRAIN_SOURCE === 'file') {
      return JSON.parse(readFileSync(new URL('../../fixtures/brain.sample.json', import.meta.url), 'utf8')) as Record<string, string[][]>;
    }
    if (!this.sheets || !this.cfg.BRAIN_SHEET_ID) throw new Error('BRAIN_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON not configured');
    return this.sheets.batchGet(this.cfg.BRAIN_SHEET_ID, [...BRAIN_TABS]);
  }

  private async reportErrors(errors: string[]) {
    this.lastSyncError = errors.join('; ');
    const sig = errors.join('|');
    if (sig === this.lastErrorSig) return; // don't spam the group every 10 minutes
    this.lastErrorSig = sig;
    const kept = this.brain ? 'Bot is still using the last good version.' : 'No earlier version exists, bot cannot start.';
    await this.alert(`Brain sheet problem. ${kept}\n${errors.slice(0, 15).map((e) => `- ${e}`).join('\n')}`);
  }

  startTimer(everyMs = 10 * 60_000): NodeJS.Timeout {
    return setInterval(() => void this.sync(), everyMs);
  }
}
