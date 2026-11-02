import { describe, expect, it } from 'vitest';
import { computeReplyDue } from '../src/engine/batching.js';
import { planDelays, typingDelaySeconds } from '../src/engine/pacing.js';
import { cleanText, cleanupBubbles, enforceSingleQuestion, limitExclamations, splitLong, stripGreeting } from '../src/engine/cleanup.js';
import { findBanned, stripBannedSentences } from '../src/engine/banned.js';
import { indianGroup, normalisePrices } from '../src/engine/format.js';
import { ackReaction, classifyAck, isOptOut } from '../src/engine/quiet.js';
import { interleavePhotos, parseReplyOutput } from '../src/engine/bubbles.js';
import { DEFAULT_SETTINGS } from '../src/brain/types.js';
import { effectiveMode, humanModeExpired } from '../src/engine/mode.js';
import { parseStudioHours } from '../src/engine/hours.js';

const pace = DEFAULT_SETTINGS;

describe('batching (rule 1)', () => {
  const t0 = new Date('2026-11-01T10:00:00Z');
  it('first message is due in 8s', () => {
    const r = computeReplyDue({ now: t0, firstPendingAt: null, batchSeconds: 8, maxSeconds: 25 });
    expect(r.dueAt.getTime() - t0.getTime()).toBe(8000);
    expect(r.firstPendingAt).toEqual(t0);
  });
  it('each message resets the timer', () => {
    const now = new Date(t0.getTime() + 6000);
    const r = computeReplyDue({ now, firstPendingAt: t0, batchSeconds: 8, maxSeconds: 25 });
    expect(r.dueAt.getTime()).toBe(now.getTime() + 8000);
  });
  it('is capped at 25s after the first message', () => {
    const now = new Date(t0.getTime() + 22000);
    const r = computeReplyDue({ now, firstPendingAt: t0, batchSeconds: 8, maxSeconds: 25 });
    expect(r.dueAt.getTime()).toBe(t0.getTime() + 25000);
  });
});

describe('pacing (rule 3)', () => {
  const mid = () => 0.5; // zero jitter
  it('short text hits the 2s floor', () => expect(typingDelaySeconds(5, pace, mid)).toBe(2));
  it('long text hits the 9s ceiling', () => expect(typingDelaySeconds(1000, pace, mid)).toBe(9));
  it('mid text follows 1.5s + 35ms/char', () => expect(typingDelaySeconds(100, pace, mid)).toBeCloseTo(5, 5));
  it('jitter stays within +/-20% and never under 2s', () => {
    for (let i = 0; i < 200; i++) {
      const d = typingDelaySeconds(100, pace);
      expect(d).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(d).toBeLessThanOrEqual(6 + 1e-9);
      expect(typingDelaySeconds(1, pace)).toBeGreaterThanOrEqual(2);
    }
  });
  it('a full reply never exceeds 30s and bubbles keep >= 2s', () => {
    const d = planDelays(['x'.repeat(250), 'x'.repeat(250), 'x'.repeat(250)], pace, () => 0.99);
    expect(d.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30 + 1e-9);
    d.forEach((x) => expect(x).toBeGreaterThanOrEqual(2 - 1e-9));
  });
  it('gaps of 1-3s between bubbles', () => {
    const d = planDelays(['a', 'b'], pace, () => 0.5);
    expect(d[1]! - d[0]!).toBeCloseTo(2, 5);
  });
});

describe('cleanup (rule 13)', () => {
  const ctx = { customerUsedEmoji: false };
  it('strips markdown, headings and bullets', () => {
    expect(cleanText('**Hello** there\n- one\n- two\n# Title', ctx)).toBe('Hello there\none\ntwo\nTitle');
  });
  it('replaces em dashes and semicolons', () => {
    expect(cleanText('Solid wood — made by hand; no veneer', ctx)).toBe('Solid wood, made by hand, no veneer');
  });
  it('formats prices with Indian grouping', () => {
    expect(normalisePrices('Rs 18500 and ₹125000 and INR 1,25,000')).toBe('Rs. 18,500 and Rs. 1,25,000 and Rs. 1,25,000');
    expect(normalisePrices('It is Rs 9500, solid teak. Or Rs. 12,000.')).toBe('It is Rs. 9,500, solid teak. Or Rs. 12,000.');
    expect(indianGroup(12500000)).toBe('1,25,00,000');
    expect(indianGroup(999)).toBe('999');
  });
  it('drops emoji unless the customer used one', () => {
    expect(cleanText('ok 🙏', ctx)).toBe('ok');
    expect(cleanText('ok 🙏', { customerUsedEmoji: true })).toBe('ok 🙏');
  });
  it('allows one exclamation mark per reply', () => {
    expect(limitExclamations(['Hi!', 'Nice! Really!'])).toEqual(['Hi!', 'Nice. Really.']);
  });
  it('splits bubbles over 250 chars', () => {
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} about the table.`).join(' ');
    const parts = splitLong([long]);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(250));
  });
  it('moves a lone question to the last bubble and keeps only one', () => {
    expect(enforceSingleQuestion(['Which city?', 'It is solid teak.'])).toEqual(['It is solid teak. Which city?']);
    expect(enforceSingleQuestion(['Which city?', 'Which wood?'])).toEqual(['Which wood?']);
    expect(enforceSingleQuestion(['Solid teak.', 'Which city?'])).toEqual(['Solid teak.', 'Which city?']);
  });
  it('strips a second greeting', () => {
    expect(stripGreeting('Hi! The table is Rs. 10,000.')).toBe('The table is Rs. 10,000.');
    expect(stripGreeting('Hello')).toBe('Hello');
  });
  it('full pass respects bubble count and flags banned phrases', () => {
    const r = cleanupBubbles(['Certainly! It is stunning.', 'b', 'c', 'd'], { ...ctx, alreadyGreeted: false });
    expect(r.bubbles.length).toBeLessThanOrEqual(3);
    expect(r.banned[0]).toEqual(expect.arrayContaining(['Certainly', 'stunning']));
  });
});

describe('banned phrases', () => {
  it('finds them case-insensitively on word boundaries', () => {
    expect(findBanned('That is AMAZING')).toEqual(['amazing']);
    expect(findBanned('Feel free to ask')).toEqual(['Feel free to']);
    expect(findBanned('A solid pine table')).toEqual([]);
  });
  it('plain fallback drops offending sentences', () => {
    expect(stripBannedSentences('It is stunning. Solid teak with a hand-rubbed finish.')).toBe('Solid teak with a hand-rubbed finish.');
  });
});

describe('quiet (rule 6) and opt-out', () => {
  it('detects acknowledgements', () => {
    expect(classifyAck(['ok'])).toBe('ack');
    expect(classifyAck(['thanks'])).toBe('ack');
    expect(classifyAck(['👍'])).toBe('thanks_emoji');
    expect(classifyAck(['ok will check with wife'])).toBe('ack');
    expect(classifyAck(['will let you know'])).toBe('ack');
    expect(classifyAck(['ok what about delivery?'])).toBeNull();
    expect(classifyAck(['how much is the sofa'])).toBeNull();
    expect(ackReaction(['👍'])).toBe('👍');
    expect(ackReaction(['thanks'])).toBe('🙏');
  });
  it('detects opt-out', () => {
    expect(isOptOut('stop')).toBe(true);
    expect(isOptOut("please don't message me")).toBe(true);
    expect(isOptOut('do not stop the delivery tomorrow')).toBe(false);
  });
});

describe('reply output + photos', () => {
  it('parses JSON even with surrounding text', () => {
    const r = parseReplyOutput('here:\n```json\n{"messages":["a","b"],"react":null,"reply_to":"m2"}\n```');
    expect(r).toEqual({ messages: ['a', 'b'], react: null, reply_to: 'm2' });
    expect(parseReplyOutput('no json')).toBeNull();
    expect(parseReplyOutput('{"messages":"x"}')).toBeNull();
  });
  it('puts the photo before the last (question) bubble', () => {
    const out = interleavePhotos(['Price line.', 'Which city?'], [{ url: 'u', caption: 'c' }], null);
    expect(out.map((b) => b.kind)).toEqual(['text', 'image', 'text']);
    const out2 = interleavePhotos(['Price line.', 'More.'], [{ url: 'u', caption: 'c' }], null);
    expect(out2.map((b) => b.kind)).toEqual(['text', 'image', 'text']);
    const out3 = interleavePhotos(['Which one?'], [{ url: 'u', caption: 'c' }], null);
    expect(out3.map((b) => b.kind)).toEqual(['image', 'text']);
  });
});

describe('modes', () => {
  const hours = parseStudioHours('Mon-Sat 10:00-19:00');
  const now = new Date('2026-11-02T05:00:00Z'); // Mon 10:30 IST
  const s = { ...DEFAULT_SETTINGS, shadowMode: false };
  it('kill switch wins', () => {
    expect(effectiveMode({ conversationMode: 'auto', settings: { ...s, botEnabled: false }, hours, now })).toBe('off');
  });
  it('human stays human', () => expect(effectiveMode({ conversationMode: 'human', settings: s, hours, now })).toBe('human'));
  it('global shadow applies to auto chats', () => {
    expect(effectiveMode({ conversationMode: 'auto', settings: { ...s, shadowMode: true }, hours, now })).toBe('shadow');
    expect(effectiveMode({ conversationMode: 'auto', settings: s, hours, now })).toBe('auto');
  });
  it('shadow during studio hours only', () => {
    const st = { ...s, shadowDuringStudioHours: true };
    expect(effectiveMode({ conversationMode: 'auto', settings: st, hours, now })).toBe('shadow');
    expect(effectiveMode({ conversationMode: 'auto', settings: st, hours, now: new Date('2026-11-02T17:00:00Z') })).toBe('auto');
  });
  it('live_numbers get real replies during shadow mode; only_live_numbers ignores everyone else', () => {
    const shadow = { ...DEFAULT_SETTINGS, shadowMode: true, liveNumbers: ['919876543210'] };
    expect(effectiveMode({ conversationMode: 'auto', settings: shadow, hours, now, waId: '919876543210' })).toBe('auto');
    expect(effectiveMode({ conversationMode: 'auto', settings: shadow, hours, now, waId: '911111111111' })).toBe('shadow');
    const pilot = { ...shadow, onlyLiveNumbers: true };
    expect(effectiveMode({ conversationMode: 'auto', settings: pilot, hours, now, waId: '911111111111' })).toBe('off');
    expect(effectiveMode({ conversationMode: 'auto', settings: pilot, hours, now, waId: '919876543210' })).toBe('auto');
    expect(effectiveMode({ conversationMode: 'human', settings: pilot, hours, now, waId: '919876543210' })).toBe('human');
    expect(effectiveMode({ conversationMode: 'auto', settings: { ...pilot, botEnabled: false }, hours, now, waId: '919876543210' })).toBe('off');
    expect(effectiveMode({ conversationMode: 'auto', settings: { ...DEFAULT_SETTINGS, shadowMode: true, onlyLiveNumbers: true }, hours, now, waId: '911111111111' })).toBe('shadow'); // empty list never silences everyone
  });
  it('human mode expires after 48h except trade/project', () => {
    const base = { modeChangedAt: new Date('2026-11-01T00:00:00Z'), lastHumanAt: null, now: new Date('2026-11-03T01:00:00Z'), timeoutHours: 48 };
    expect(humanModeExpired({ ...base, leadType: 'home' })).toBe(true);
    expect(humanModeExpired({ ...base, leadType: 'trade' })).toBe(false);
    expect(humanModeExpired({ ...base, now: new Date('2026-11-02T00:00:00Z'), leadType: 'home' })).toBe(false);
  });
});
