import { describe, expect, it } from 'vitest';
import { computeReplyBy, describeHours, describeTime, isOpenNow, nextOpen, parseStudioHours } from '../src/engine/hours.js';
import { istDate } from '../src/engine/time.js';

const h = parseStudioHours('Mon-Sat 10:00-19:00', '2026-11-09');

describe('studio hours', () => {
  it('parses and rejects junk', () => {
    expect(() => parseStudioHours('whenever')).toThrow();
    expect(() => parseStudioHours('Mon-Sat 19:00-10:00')).toThrow();
    expect(parseStudioHours('Mon-Fri 10am-7pm; Sat 11:00-17:00').days[6]).toEqual({ open: 660, close: 1020 });
  });
  it('knows open vs closed (IST)', () => {
    expect(isOpenNow(h, istDate(2026, 11, 2, 11, 0))).toBe(true); // Mon
    expect(isOpenNow(h, istDate(2026, 11, 2, 22, 0))).toBe(false);
    expect(isOpenNow(h, istDate(2026, 11, 1, 12, 0))).toBe(false); // Sunday
    expect(isOpenNow(h, istDate(2026, 11, 9, 12, 0))).toBe(false); // holiday
  });
  it('next open skips Sunday and holidays', () => {
    expect(nextOpen(h, istDate(2026, 11, 7, 20, 0))).toEqual(istDate(2026, 11, 10, 10, 0)); // Sat night -> Mon is holiday -> Tue
    expect(nextOpen(h, istDate(2026, 11, 2, 23, 40))).toEqual(istDate(2026, 11, 3, 10, 0));
  });
  it('reply-by is 2 open hours, carrying past closing', () => {
    expect(computeReplyBy(h, istDate(2026, 11, 2, 14, 0), 2)).toEqual(istDate(2026, 11, 2, 16, 0));
    expect(computeReplyBy(h, istDate(2026, 11, 2, 18, 0), 2)).toEqual(istDate(2026, 11, 3, 11, 0));
    expect(computeReplyBy(h, istDate(2026, 11, 2, 23, 40), 2)).toEqual(istDate(2026, 11, 3, 12, 0));
  });
  it('describes times the way people say them', () => {
    const now = istDate(2026, 11, 2, 14, 0);
    expect(describeTime(istDate(2026, 11, 2, 16, 0), now)).toBe('4 pm today');
    expect(describeTime(istDate(2026, 11, 3, 10, 0), now)).toBe('10 am tomorrow');
    expect(describeTime(istDate(2026, 11, 5, 10, 30), now)).toBe('10:30 am on Thursday');
  });
  it('summarises hours for the prompt', () => {
    expect(describeHours(parseStudioHours('Mon-Sat 10:00-19:00'))).toBe('Mon-Sat 10 am-7 pm');
  });
});
