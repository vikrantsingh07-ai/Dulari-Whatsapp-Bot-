type F = typeof fetch;

export interface TokenCheck { ok: boolean; message: string }

/** Asks WhatsApp whether this token can see this phone number, and explains a refusal in plain words. */
export async function checkToken(f: F, token: string, phoneNumberId: string, v = 'v21.0'): Promise<TokenCheck> {
  const r = await f(`https://graph.facebook.com/${v}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  const j: any = await r.json().catch(() => ({}));
  if (r.ok && j.display_phone_number) return { ok: true, message: `Token works. It can use ${j.display_phone_number}${j.verified_name ? ` (${j.verified_name})` : ''}.` };
  const err = String(j.error?.message ?? `HTTP ${r.status}`);
  const code = j.error?.code;
  if (/expired/i.test(err) || code === 190 && /session/i.test(err)) return { ok: false, message: `The token has EXPIRED (${err}). Make a new one (the permanent system-user token never expires).` };
  if (/invalid|malformed|parse/i.test(err) || code === 190) return { ok: false, message: `Meta does not recognise this token (${err}). It was copied incompletely, has extra spaces, or was revoked. Generate it again and copy the whole text.` };
  if (code === 100 || code === 10 || code === 200 || /permission|does not exist|unsupported get request|missing/i.test(err)) return { ok: false, message: `The token is valid but is NOT allowed to use this phone number (${err}). In Business settings -> System users -> dulari-bot -> Add assets, give the system user Full control of the WhatsApp account that owns this number (and of the app), then generate the token again.` };
  return { ok: false, message: `Meta said: ${err}` };
}
