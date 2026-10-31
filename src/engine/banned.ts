export const BANNED_PHRASES = [
  'Certainly', 'Absolutely', "I'd be happy to", 'Great question', 'Feel free to', 'Kindly',
  'Dear customer', 'Hope this helps', 'Is there anything else', 'I understand your concern',
  'As an AI', 'Thank you for reaching out', 'delighted', 'stunning', 'amazing', 'perfect for',
  'elevate', 'exquisite', 'premium quality',
  // hype words from the system prompt's "never use" list
  'luxurious',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = BANNED_PHRASES.map((p) => ({ p, re: new RegExp(`(^|[^\\p{L}])${esc(p)}($|[^\\p{L}])`, 'iu') }));

export function findBanned(text: string): string[] {
  const norm = text.replace(/[‘’]/g, "'");
  return patterns.filter(({ re }) => re.test(norm)).map(({ p }) => p);
}

/** Last-resort plain version: drop any sentence that still contains a banned phrase. */
export function stripBannedSentences(text: string): string {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  return sentences.filter((s) => findBanned(s).length === 0).join('').trim();
}
