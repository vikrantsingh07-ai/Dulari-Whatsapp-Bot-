/** Output contract of the system prompt: {"messages":[...],"react":null|emoji,"reply_to":null|id} */
export interface ReplyOutput {
  messages: string[];
  react: string | null;
  reply_to: string | null;
}

function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** Tolerant parse; returns null if the text is not a usable reply object. */
export function parseReplyOutput(text: string): ReplyOutput | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let o: unknown;
  try { o = JSON.parse(json); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.messages)) return null;
  const messages = r.messages.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim());
  return {
    messages,
    react: typeof r.react === 'string' && r.react.trim() ? r.react.trim() : null,
    reply_to: typeof r.reply_to === 'string' && r.reply_to.trim() ? r.reply_to.trim() : null,
  };
}

export type Bubble =
  | { kind: 'text'; text: string; replyTo?: string | null }
  | { kind: 'image'; url: string; caption: string };

/**
 * Photos go before the last text bubble when that bubble asks the question
 * (so the question stays last), otherwise right after the first bubble.
 */
export function interleavePhotos(texts: string[], photos: { url: string; caption: string }[], replyTo: string | null): Bubble[] {
  const t: Bubble[] = texts.map((text, i) => ({ kind: 'text', text, replyTo: i === 0 ? replyTo : null }));
  const p: Bubble[] = photos.slice(0, 3).map((x) => ({ kind: 'image', url: x.url, caption: x.caption }));
  if (!p.length) return t;
  if (!t.length) return p;
  const lastIsQuestion = /\?\s*$/.test((t[t.length - 1] as { text: string }).text);
  const at = lastIsQuestion ? t.length - 1 : 1;
  return [...t.slice(0, at), ...p, ...t.slice(at)];
}
