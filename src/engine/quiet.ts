const ACK_START = /^(ok+|okay|k|kk|thanks?|thank you|thank u|thx|ty|tysm|sure|fine|done|got it|noted|cool|great|alright|all right|theek hai|thik hai|accha|acha|shukriya|dhanyavad|dhanyawad|ji|yes ji|haan ji|👍|🙏|👌)\b/i;
const ACK_PHRASES = /(will (let you know|get back|check|think|revert|discuss|talk|ask|call)|let you know|get back to you|will see|dekhte hain|baad mein|sochke bataunga|bata dunga|bata dungi)/i;
const ONLY_EMOJI = /^[\s\p{Extended_Pictographic}‍️]+$/u;

export type AckKind = 'thanks_emoji' | 'ack' | null;

/**
 * Rule 6: decide whether a batch of customer messages is just an acknowledgement
 * (ok, thanks, thumbs-up, "will let you know"), which gets a reaction or one short line.
 */
export function classifyAck(texts: string[]): AckKind {
  const joined = texts.map((t) => t.trim()).filter(Boolean);
  if (!joined.length) return null;
  const all = joined.join(' ');
  if (all.includes('?')) return null;
  if (all.split(/\s+/).length > 9) return null;
  if (joined.every((t) => ONLY_EMOJI.test(t))) return 'thanks_emoji';
  if (joined.every((t) => ACK_START.test(t) || ACK_PHRASES.test(t) || ONLY_EMOJI.test(t))) return 'ack';
  if (ACK_PHRASES.test(all) && !/\d/.test(all)) return 'ack';
  return null;
}

const OPT_OUT = /^(?:\s*)(stop|unsubscribe|opt ?out)\b|don'?t (message|text|msg|contact) me|do not (message|text|contact) me|stop (messaging|texting|sending)|mat bhejo|message mat karo|band karo (messages?|msg)/i;
export function isOptOut(text: string): boolean {
  return text.trim().length <= 80 && OPT_OUT.test(text.trim());
}

const THUMB = /👍/;
export function ackReaction(texts: string[]): string {
  return texts.some((t) => THUMB.test(t)) ? '👍' : '🙏';
}
