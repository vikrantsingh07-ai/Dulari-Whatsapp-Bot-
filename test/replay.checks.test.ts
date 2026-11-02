import { describe, expect, it } from 'vitest';
import { checkTurn } from './replay/checks.js';
import { parseBrain } from '../src/brain/parse.js';
import { goodTables } from './integration/harness.js';

const brain = parseBrain(goodTables).brain!;
const turn = (texts: string[], extra = {}) => ({ texts, photos: 0, reaction: null, handedOff: false, ...extra });

describe('replay checks', () => {
  it('passes a clean reply', () => expect(checkTurn(turn(['Rs. 9,500, solid teak.', 'Which city?']), brain)).toEqual([]));
  it('flags wrong prices, banned phrases, long bubbles, extra questions', () => {
    expect(checkTurn(turn(['Rs. 9,900 for it.']), brain).join()).toMatch(/not in the sheet/);
    expect(checkTurn(turn(['It is stunning.']), brain).join()).toMatch(/banned/);
    expect(checkTurn(turn(['x'.repeat(260)]), brain).join()).toMatch(/260 chars/);
    expect(checkTurn(turn(['Where?', 'When?']), brain).join()).toMatch(/2 questions/);
    expect(checkTurn(turn(['Where? ok', 'Fine.']), brain).join()).toMatch(/not in the last/);
    expect(checkTurn(turn(['a', 'b', 'c', 'd']), brain).join()).toMatch(/4 bubbles/);
  });
  it('flags leaked internal wording', () => {
    expect(checkTurn(turn(['The sheet shows solid wood (SAMPLE) as a placeholder.']), brain).join()).toMatch(/leaks internal wording/);
    expect(checkTurn(turn(['I will check the wood with Akash.']), brain)).toEqual([]);
  });
  it('checks expectations', () => {
    expect(checkTurn(turn(['hi']), brain, { handoff: true })).toContain('expected a handoff');
    expect(checkTurn(turn([], { reaction: '🙏' }), brain, { noText: true, reaction: true })).toEqual([]);
    expect(checkTurn(turn(['hello']), brain, { devanagari: true })).toContain('expected Devanagari script');
  });
});
