// All studio logic runs in IST. Pure helpers, no globals.
export const TZ = 'Asia/Kolkata';

export interface IstParts {
  year: number; month: number; day: number;
  hour: number; minute: number;
  weekday: number; // 0=Sun..6=Sat
  dateKey: string; // YYYY-MM-DD
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function istParts(d: Date): IstParts {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const year = Number(p.year), month = Number(p.month), day = Number(p.day);
  return {
    year, month, day, hour: Number(p.hour), minute: Number(p.minute),
    weekday: WD[p.weekday as string] ?? 0,
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Build a Date from an IST wall-clock time (IST is a fixed +05:30, no DST). */
export function istDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - (5 * 60 + 30) * 60_000);
}

export function addDaysIst(p: IstParts, n: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function formatDateTimeIst(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}
