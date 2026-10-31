import { findBanned } from '../../src/engine/banned.js';
import { indianGroup } from '../../src/engine/format.js';
import type { Brain } from '../../src/brain/types.js';

export interface Turn { texts: string[]; photos: number; reaction: string | null; handedOff: boolean }
export interface Expect {
  handoff?: boolean;
  photo?: boolean;
  reaction?: boolean;
  noText?: boolean;
  devanagari?: boolean;
  mustMatch?: RegExp[];
  mustNotMatch?: RegExp[];
}

/** Automatic checks from the spec: wrong facts, banned phrases, bubble length, question count (+ style rules). */
export function checkTurn(turn: Turn, brain: Brain, exp: Expect = {}): string[] {
  const fails: string[] = [];
  const { texts } = turn;
  if (texts.length > 3) fails.push(`${texts.length} bubbles (max 3)`);
  texts.forEach((t, i) => {
    if (t.length > 250) fails.push(`bubble ${i + 1} is ${t.length} chars (max ~250)`);
    const banned = findBanned(t);
    if (banned.length) fails.push(`banned phrase: ${banned.join(', ')}`);
    if (/\*\*|^#|^\s*[-•]\s|—|;/m.test(t)) fails.push(`markdown/em dash/semicolon in bubble ${i + 1}`);
  });
  const joined = texts.join(' ');
  const questions = (joined.match(/\?/g) ?? []).length;
  if (questions > 1) fails.push(`${questions} questions (max 1)`);
  if (questions === 1 && !/\?\s*$/.test(texts[texts.length - 1] ?? '')) fails.push('the question is not in the last bubble');
  if ((joined.match(/!/g) ?? []).length > 1) fails.push('more than one exclamation mark');

  // Wrong facts: every price must be a real product price from the sheet.
  const prices = new Set(brain.products.map((p) => indianGroup(p.price)));
  for (const m of joined.matchAll(/Rs\.\s*(\d(?:[\d,]*\d)?(?:\.\d+)?)/g)) if (!prices.has(m[1]!)) fails.push(`price Rs. ${m[1]} is not in the sheet`);
  if (/\b(10|15|20|25|30)\s*%\s*(off|discount)/i.test(joined)) fails.push('offered a discount');

  if (exp.handoff !== undefined && turn.handedOff !== exp.handoff) fails.push(exp.handoff ? 'expected a handoff' : 'unexpected handoff');
  if (exp.photo !== undefined && (turn.photos > 0) !== exp.photo) fails.push(exp.photo ? 'expected a product photo' : 'unexpected photo');
  if (exp.reaction !== undefined && (turn.reaction !== null) !== exp.reaction) fails.push(exp.reaction ? 'expected a reaction' : 'unexpected reaction');
  if (exp.noText && texts.length) fails.push('expected no text');
  if (exp.devanagari && !/[ऀ-ॿ]/.test(joined)) fails.push('expected Devanagari script');
  for (const re of exp.mustMatch ?? []) if (!re.test(joined)) fails.push(`expected to match ${re}`);
  for (const re of exp.mustNotMatch ?? []) if (re.test(joined)) fails.push(`must not match ${re}`);
  return fails;
}
