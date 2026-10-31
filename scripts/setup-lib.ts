import { randomBytes } from 'node:crypto';

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('hex');

/** Accepts a full Google Sheets link or a bare id. */
export function extractSheetId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1]!;
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

/** Supabase shows "[YOUR-PASSWORD]" inside the connection string. Fills it in (URL-encoded). */
export function fillPassword(url: string, password: string): string {
  return url.replace('[YOUR-PASSWORD]', encodeURIComponent(password));
}
export const needsPassword = (url: string) => url.includes('[YOUR-PASSWORD]');
export const looksLikePostgres = (url: string) => /^postgres(ql)?:\/\/[^\s]+@[^\s]+\/[^\s]+$/.test(url.trim());

export function parseHyperdriveId(output: string, name?: string): string | null {
  const json = output.match(/"id":\s*"([0-9a-f]{32})"/i);
  if (json) return json[1]!;
  for (const line of output.split('\n')) if ((!name || line.includes(name)) && /[0-9a-f]{32}/i.test(line)) return line.match(/[0-9a-f]{32}/i)![0];
  return null;
}

export function patchHyperdriveId(wranglerJsonc: string, id: string): string {
  return wranglerJsonc.replace(/("binding":\s*"HYPERDRIVE",\s*"id":\s*")[^"]*(")/, `$1${id}$2`);
}
export function currentHyperdriveId(wranglerJsonc: string): string | null {
  const m = wranglerJsonc.match(/"binding":\s*"HYPERDRIVE",\s*"id":\s*"([^"]*)"/);
  return m && !m[1]!.startsWith('REPLACE') ? m[1]! : null;
}

export function parseWorkerUrl(output: string): string | null {
  return output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i)?.[0] ?? null;
}

/** Newest group/supergroup chat id from Telegram getUpdates. */
export function pickGroupChatId(updates: any): { id: string; title: string } | null {
  const list: any[] = updates?.result ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const chat = list[i]?.message?.chat ?? list[i]?.my_chat_member?.chat ?? list[i]?.channel_post?.chat;
    if (chat && (chat.type === 'group' || chat.type === 'supergroup')) return { id: String(chat.id), title: chat.title ?? '' };
  }
  return null;
}

export function toBase64(text: string): string { return Buffer.from(text, 'utf8').toString('base64'); }

/** Sets a string value inside the "vars" block of wrangler.jsonc. */
export function patchVar(wranglerJsonc: string, name: string, value: string): string {
  const re = new RegExp(`("${name}":\\s*")[^"]*(")`);
  if (!re.test(wranglerJsonc)) throw new Error(`wrangler.jsonc has no "${name}" setting`);
  return wranglerJsonc.replace(re, (_m, a, b) => `${a}${value.replace(/"/g, '')}${b}`);
}
