import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verifies Meta's X-Hub-Signature-256 over the RAW request body. */
export function verifySignature(rawBody: string, header: string | undefined | null, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const given = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try { b = Buffer.from(given, 'hex'); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signBody(rawBody: string, appSecret: string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
}
