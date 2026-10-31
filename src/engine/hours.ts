import { addDaysIst, istDate, istParts, type IstParts } from './time.js';

/** minutes since midnight */
export interface DayHours { open: number; close: number }
export interface StudioHours {
  days: Partial<Record<number, DayHours>>; // 0=Sun..6=Sat
  holidays: Set<string>; // YYYY-MM-DD
  raw: string;
}

const DAY_IDX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseClock(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parses e.g. "Mon-Sat 10:00-19:00" or "Mon-Fri 10:00-19:00; Sat 11am-5pm".
 * Throws on anything it cannot read so the sheet sync can reject the edit.
 */
export function parseStudioHours(raw: string, holidays = ''): StudioHours {
  const days: Partial<Record<number, DayHours>> = {};
  const parts = raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('studio_hours is empty');
  for (const part of parts) {
    const m = part.match(/^([A-Za-z]{3})(?:\s*-\s*([A-Za-z]{3}))?\s+(.+?)\s*-\s*(.+)$/);
    if (!m) throw new Error(`Cannot read studio_hours segment "${part}"`);
    const a = DAY_IDX[m[1]!.toLowerCase()];
    const b = m[2] ? DAY_IDX[m[2].toLowerCase()] : a;
    const open = parseClock(m[3]!);
    const close = parseClock(m[4]!);
    if (a === undefined || b === undefined || open === null || close === null || close <= open) {
      throw new Error(`Cannot read studio_hours segment "${part}"`);
    }
    for (let d = a, guard = 0; guard < 8; d = (d + 1) % 7, guard++) {
      days[d] = { open, close };
      if (d === b) break;
    }
  }
  const hs = new Set(
    holidays.split(/[,\n]/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
  );
  return { days, holidays: hs, raw };
}

function hoursFor(h: StudioHours, p: { year: number; month: number; day: number; weekday?: number }): DayHours | undefined {
  const key = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (h.holidays.has(key)) return undefined;
  const wd = p.weekday ?? new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return h.days[wd];
}

export function isOpenNow(h: StudioHours, now: Date): boolean {
  const p = istParts(now);
  const dh = hoursFor(h, p);
  if (!dh) return false;
  const m = p.hour * 60 + p.minute;
  return m >= dh.open && m < dh.close;
}

/** Next moment the studio is open, at or after `from`. */
export function nextOpen(h: StudioHours, from: Date): Date {
  const p = istParts(from);
  for (let i = 0; i < 15; i++) {
    const day = addDaysIst(p, i);
    const dh = hoursFor(h, day);
    if (!dh) continue;
    const start = istDate(day.year, day.month, day.day, Math.floor(dh.open / 60), dh.open % 60);
    const end = istDate(day.year, day.month, day.day, Math.floor(dh.close / 60), dh.close % 60);
    if (from < start) return start;
    if (from < end) return from;
  }
  throw new Error('studio has no open hours in the next 15 days');
}

/**
 * The honest promised time: `windowHours` of OPEN time from now. If the window runs
 * past closing, the remainder carries to the next opening.
 */
export function computeReplyBy(h: StudioHours, now: Date, windowHours: number): Date {
  let remaining = windowHours * 60;
  let cursor = nextOpen(h, now);
  for (let guard = 0; guard < 30; guard++) {
    const p = istParts(cursor);
    const dh = hoursFor(h, p)!;
    const left = dh.close - (p.hour * 60 + p.minute);
    if (remaining <= left) return new Date(cursor.getTime() + remaining * 60_000);
    remaining -= left;
    cursor = nextOpen(h, new Date(cursor.getTime() + left * 60_000 + 60_000));
  }
  return cursor;
}

function clock12(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour >= 12 ? 'pm' : 'am';
  return minute ? `${h}:${String(minute).padStart(2, '0')} ${suffix}` : `${h} ${suffix}`;
}

/** Human phrasing, like a person would say it: "by 4 today", "by 10 tomorrow", "by 10 on Monday". */
export function describeTime(target: Date, now: Date): string {
  const t = istParts(target);
  const n = istParts(now);
  const diffDays = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(n.year, n.month - 1, n.day)) / 86_400_000);
  const clock = clock12(t.hour, t.minute);
  if (diffDays <= 0) return `${clock} today`;
  if (diffDays === 1) return `${clock} tomorrow`;
  const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][t.weekday]!;
  return `${clock} on ${name}`;
}

export function describeHours(h: StudioHours): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const groups: string[] = [];
  for (let d = 0; d < 7; d++) {
    const dh = h.days[d];
    if (!dh) continue;
    const label = `${clock12(Math.floor(dh.open / 60), dh.open % 60)}-${clock12(Math.floor(dh.close / 60), dh.close % 60)}`;
    const last = groups[groups.length - 1];
    if (last && last.endsWith(label) && d > 0 && h.days[d - 1] && h.days[d - 1]!.open === dh.open && h.days[d - 1]!.close === dh.close) {
      const first = last.split(' ')[0]!.split('-')[0]!;
      groups[groups.length - 1] = `${first}-${names[d]} ${label}`;
    } else groups.push(`${names[d]} ${label}`);
  }
  return groups.join(', ') + (h.holidays.size ? ` (closed: ${[...h.holidays].join(', ')})` : '');
}

export type { IstParts };
