import type { Table } from './parse.js';

interface ServiceAccount { client_email: string; private_key: string }

function credentials(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : atob(raw.trim());
  return JSON.parse(text) as ServiceAccount;
}

const b64url = (buf: ArrayBuffer | string) => {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function signJwt(sa: ServiceAccount, scope: string, now: number): Promise<string> {
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

/** Google Sheets over plain fetch + WebCrypto (works on Cloudflare Workers and Node 20+). */
export class SheetsClient {
  private sa: ServiceAccount;
  private token: { value: string; expires: number } | null = null;
  constructor(serviceAccountJson: string, private base = 'https://sheets.googleapis.com', private tokenUrl = 'https://oauth2.googleapis.com/token') {
    this.sa = credentials(serviceAccountJson);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const jwt = await signJwt(this.sa, 'https://www.googleapis.com/auth/spreadsheets', Math.floor(Date.now() / 1000));
    const res = await fetch(this.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`Google token: ${j.error_description ?? j.error ?? res.status}`);
    this.token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3500) * 1000 };
    return this.token.value;
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sheets ${res.status}: ${j?.error?.message ?? 'request failed'}`);
    return j as T;
  }

  async batchGet(sheetId: string, tabs: string[]): Promise<Record<string, Table>> {
    const q = tabs.map((t) => `ranges=${encodeURIComponent(t)}`).join('&');
    const j = await this.req<{ valueRanges?: { values?: string[][] }[] }>(`/v4/spreadsheets/${sheetId}/values:batchGet?${q}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    const out: Record<string, Table> = {};
    tabs.forEach((t, i) => { out[t] = j.valueRanges?.[i]?.values ?? []; });
    return out;
  }

  /** Replaces the whole tab with `values` (header first). */
  async replaceTab(sheetId: string, tab: string, values: (string | number | boolean)[][]): Promise<void> {
    const range = encodeURIComponent(tab);
    await this.req(`/v4/spreadsheets/${sheetId}/values/${range}:clear`, { method: 'POST', body: {} });
    await this.req(`/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`, { method: 'PUT', body: { values } });
  }
}
