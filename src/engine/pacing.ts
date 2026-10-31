export interface PacingSettings {
  typingBaseMs: number;
  typingMsPerChar: number;
  typingMinSeconds: number;
  typingMaxSeconds: number;
  jitter: number;
  gapMinSeconds: number;
  gapMaxSeconds: number;
  replyMaxSeconds: number;
}

/** Rule 3: clamp(1.5s + 35ms/char, 2s, 9s) with +/-20% jitter. `rand` returns [0,1). */
export function typingDelaySeconds(chars: number, s: PacingSettings, rand: () => number = Math.random): number {
  const base = (s.typingBaseMs + s.typingMsPerChar * chars) / 1000;
  const clamped = Math.min(Math.max(base, s.typingMinSeconds), s.typingMaxSeconds);
  const jitter = 1 + (rand() * 2 - 1) * s.jitter;
  // jitter must never push us below the floor
  return Math.max(clamped * jitter, s.typingMinSeconds);
}

/**
 * Wait (seconds) before each bubble. Bubble 0 waits its typing delay; later bubbles
 * also get a 1-3s gap. Whole reply is capped at replyMaxSeconds (each bubble keeps >= min).
 */
export function planDelays(bubbles: string[], s: PacingSettings, rand: () => number = Math.random): number[] {
  const delays = bubbles.map((b, i) => {
    const typing = typingDelaySeconds(b.length, s, rand);
    const gap = i === 0 ? 0 : s.gapMinSeconds + rand() * (s.gapMaxSeconds - s.gapMinSeconds);
    return typing + gap;
  });
  const total = delays.reduce((a, b) => a + b, 0);
  if (total <= s.replyMaxSeconds) return delays;
  const floorTotal = delays.length * s.typingMinSeconds;
  if (floorTotal >= s.replyMaxSeconds) return delays.map(() => s.replyMaxSeconds / delays.length);
  const room = s.replyMaxSeconds - floorTotal;
  const extra = delays.map((d) => Math.max(d - s.typingMinSeconds, 0));
  const extraTotal = extra.reduce((a, b) => a + b, 0) || 1;
  return delays.map((_, i) => s.typingMinSeconds + (extra[i]! / extraTotal) * room);
}
