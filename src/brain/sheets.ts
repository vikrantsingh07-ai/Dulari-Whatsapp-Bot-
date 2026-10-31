import { JWT } from 'google-auth-library';
import type { Table } from './parse.js';

function credentials(raw: string) {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text) as { client_email: string; private_key: string };
}

export class SheetsClient {
  private jwt: JWT;
  constructor(serviceAccountJson: string) {
    const c = credentials(serviceAccountJson);
    this.jwt = new JWT({ email: c.client_email, key: c.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  }
  private async req<T>(url: string, init: { method?: string; data?: unknown } = {}): Promise<T> {
    const r = await this.jwt.request<T>({ url, method: (init.method as any) ?? 'GET', data: init.data });
    return r.data;
  }
  async batchGet(sheetId: string, tabs: string[]): Promise<Record<string, Table>> {
    const q = tabs.map((t) => `ranges=${encodeURIComponent(t)}`).join('&');
    const j = await this.req<{ valueRanges?: { range: string; values?: string[][] }[] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${q}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    const out: Record<string, Table> = {};
    tabs.forEach((t, i) => { out[t] = j.valueRanges?.[i]?.values ?? []; });
    return out;
  }
  /** Replaces the whole tab with `values` (header first). */
  async replaceTab(sheetId: string, tab: string, values: (string | number | boolean)[][]): Promise<void> {
    const range = encodeURIComponent(tab);
    await this.req(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:clear`, { method: 'POST', data: {} });
    await this.req(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`, { method: 'PUT', data: { values } });
  }
}
