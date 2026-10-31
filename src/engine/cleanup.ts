import { findBanned } from './banned.js';
import { normalisePrices } from './format.js';

const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

export function containsEmoji(s: string): boolean {
  return new RegExp(EMOJI_RE.source, 'u').test(s);
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_(?!\s)(.+?)_(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2');
}

export interface CleanupContext {
  /** the customer has used an emoji (so we may too) */
  customerUsedEmoji: boolean;
}

/** One bubble, without the cross-bubble rules (exclamation count, question placement). */
export function cleanText(text: string, ctx: CleanupContext): string {
  let t = stripMarkdown(text);
  t = t.replace(/\s*[—–]\s*/g, ', '); // em/en dash -> comma
  t = t.replace(/\s*;\s*/g, ', ');
  t = normalisePrices(t);
  if (!ctx.customerUsedEmoji) t = t.replace(EMOJI_RE, '');
  t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/ +([,.!?])/g, '$1').replace(/,\s*,/g, ',').trim();
  return t;
}

/** At most one "!" per reply across all bubbles. */
export function limitExclamations(bubbles: string[]): string[] {
  let seen = false;
  return bubbles.map((b) =>
    b.replace(/!+/g, () => {
      if (!seen) { seen = true; return '!'; }
      return '.';
    }),
  );
}

export function splitSentences(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

/** Break any bubble over `max` chars at sentence (then word) boundaries. */
export function splitLong(bubbles: string[], max = 250): string[] {
  const out: string[] = [];
  for (const b of bubbles) {
    if (b.length <= max) { out.push(b); continue; }
    let cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (const s of splitSentences(b)) {
      if (s.length > max) {
        push();
        let w = '';
        for (const word of s.split(' ')) {
          if ((w + ' ' + word).trim().length > max) { out.push(w.trim()); w = word; } else w = (w + ' ' + word).trim();
        }
        cur = w;
      } else if ((cur + ' ' + s).trim().length > max) { push(); cur = s; } else cur = (cur + ' ' + s).trim();
    }
    push();
  }
  return out;
}

const isQuestion = (s: string) => /\?\s*$/.test(s.trim());

/** At most one question, and it must be in the last bubble. */
export function enforceSingleQuestion(bubbles: string[]): string[] {
  const questions: string[] = [];
  const stripped = bubbles.map((b) =>
    splitSentences(b).filter((s) => {
      if (isQuestion(s)) { questions.push(s); return false; }
      return true;
    }).join(' ').trim(),
  );
  if (!questions.length) return bubbles;
  const lastBubbleQuestions = splitSentences(bubbles[bubbles.length - 1] ?? '').filter(isQuestion);
  const alreadyOk = questions.length === 1 && lastBubbleQuestions.length === 1;
  if (alreadyOk) return bubbles;
  const keep = questions[questions.length - 1]!;
  const out = [...stripped];
  const lastIdx = out.length - 1;
  out[lastIdx] = `${out[lastIdx] ?? ''} ${keep}`.trim();
  return out.filter(Boolean);
}

const GREETING_RE = /^\s*(?:hi|hello|hey|namaste|namaskar|hii+)\b[\s,!.:-]*(?:there|ji)?[\s,!.:-]*/i;
/** "Never greet twice in 24 hours": drop an opening greeting when we already greeted. */
export function stripGreeting(bubble: string): string {
  const stripped = bubble.replace(GREETING_RE, '').trim();
  if (!stripped) return bubble;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export interface CleanupResult { bubbles: string[]; banned: string[][] }

/**
 * Whole clean-up pass (spec rule 13 + question rule). Banned-phrase REWRITES by Haiku are
 * done by the caller using `banned`, because they need an API call.
 */
export function cleanupBubbles(raw: string[], ctx: CleanupContext & { alreadyGreeted: boolean }): CleanupResult {
  let b = raw.map((x) => cleanText(x, ctx)).filter(Boolean);
  if (ctx.alreadyGreeted && b[0]) b[0] = stripGreeting(b[0]);
  b = limitExclamations(b);
  b = splitLong(b);
  b = enforceSingleQuestion(b);
  b = b.slice(0, 3);
  return { bubbles: b, banned: b.map(findBanned) };
}
