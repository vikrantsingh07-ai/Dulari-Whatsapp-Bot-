import type { Settings } from '../brain/types.js';
import { isOpenNow, type StudioHours } from './hours.js';

export type BotMode = 'auto' | 'human' | 'shadow' | 'off';

/** The one function that decides whether the bot may speak (spec: "Bot modes"). */
export function effectiveMode(opts: {
  conversationMode: BotMode;
  settings: Settings;
  hours: StudioHours;
  now: Date;
}): BotMode {
  const { conversationMode, settings } = opts;
  if (!settings.botEnabled) return 'off';
  if (conversationMode === 'off') return 'off';
  if (conversationMode === 'human') return 'human';
  if (conversationMode === 'shadow') return 'shadow';
  if (settings.shadowMode) return 'shadow';
  if (settings.shadowDuringStudioHours && isOpenNow(opts.hours, opts.now)) return 'shadow';
  return 'auto';
}

/** Rule 15 + bot-mode table: human mode ends on release or after N hours, except trade/project leads. */
export function humanModeExpired(opts: {
  lastHumanAt: Date | null;
  modeChangedAt: Date;
  now: Date;
  timeoutHours: number;
  leadType: string | null;
}): boolean {
  if (opts.leadType === 'trade' || opts.leadType === 'project') return false;
  const ref = opts.lastHumanAt ?? opts.modeChangedAt;
  return opts.now.getTime() - ref.getTime() >= opts.timeoutHours * 3_600_000;
}
