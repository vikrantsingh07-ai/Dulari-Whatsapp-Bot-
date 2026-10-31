import { DEFAULT_SETTINGS, type Brain, type FaqRow, type PolicyRow, type Product, type Settings, type TeamMember } from './types.js';
import { parseStudioHours } from '../engine/hours.js';

export type Table = string[][]; // raw sheet values, first row = header
export interface ParseResult { brain: Brain | null; errors: string[] }

const key = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const truthy = (s: string) => ['true', 'yes', 'y', '1', 'in stock', 'available'].includes(s.trim().toLowerCase());
const falsy = (s: string) => ['false', 'no', 'n', '0', 'out of stock', 'unavailable'].includes(s.trim().toLowerCase());

function rows(t: Table | undefined): { n: number; r: Record<string, string> }[] {
  if (!t?.length) return [];
  const header = t[0]!.map(key);
  return t.slice(1).map((cells, i) => ({
    n: i + 2, // sheet row number
    r: Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? '').toString().trim()])),
  })).filter((x) => Object.values(x.r).some(Boolean));
}
const pick = (r: Record<string, string>, ...names: string[]) => { for (const n of names) if (r[n]) return r[n]!; return ''; };
const splitList = (s: string) => s.split(/[\n,|]+/).map((x) => x.trim()).filter(Boolean);

export function parseProducts(t: Table | undefined, errors: string[]): Product[] {
  const out: Product[] = [];
  const handles = new Set<string>();
  for (const { n, r } of rows(t)) {
    const name = pick(r, 'name', 'product');
    const handle = pick(r, 'website_handle', 'handle').toLowerCase();
    const activeRaw = pick(r, 'active');
    const active = activeRaw === '' ? true : !falsy(activeRaw);
    if (!name) { errors.push(`Products row ${n}: name is empty`); continue; }
    if (!handle) { errors.push(`Products row ${n} (${name}): website handle is empty`); continue; }
    if (handles.has(handle)) { errors.push(`Products row ${n} (${name}): duplicate handle "${handle}"`); continue; }
    handles.add(handle);
    const priceRaw = pick(r, 'price').replace(/(?:rs\.?|inr|₹|,|\s)/gi, '');
    const price = Number(priceRaw);
    if (active && (!priceRaw || !Number.isFinite(price) || price <= 0)) {
      errors.push(`Products row ${n} (${name}): price "${pick(r, 'price')}" is not a number`);
      continue;
    }
    const stockRaw = pick(r, 'in_stock', 'stock');
    out.push({
      name, handle, otherNames: splitList(pick(r, 'other_names', 'aliases')), price: Number.isFinite(price) ? price : 0,
      size: pick(r, 'size', 'sizes'), woods: pick(r, 'woods', 'wood'), finishes: pick(r, 'finishes', 'finish'),
      leadTime: pick(r, 'lead_time'), inStock: stockRaw === '' ? true : truthy(stockRaw),
      photoUrls: splitList(pick(r, 'photo_urls', 'photos', 'photo_url')).filter((u) => /^https?:\/\//.test(u)),
      productUrl: pick(r, 'product_url', 'url'), notes: pick(r, 'notes'), active,
    });
  }
  return out;
}

export function parseFaq(t: Table | undefined, errors: string[]): FaqRow[] {
  const out: FaqRow[] = [];
  for (const { n, r } of rows(t)) {
    const q = pick(r, 'question', 'q'), a = pick(r, 'answer', 'a');
    if (!q || !a) { errors.push(`FAQ row ${n}: needs both a question and an answer`); continue; }
    out.push({ question: q, answer: a });
  }
  return out;
}

export function parsePolicies(t: Table | undefined, errors: string[]): PolicyRow[] {
  if (!t?.length) return [];
  const header = t[0]!.map((h) => h.trim());
  const data = rows(t);
  const out: PolicyRow[] = [];
  // Wide layout: headers are topics (delivery, payment...) with one row of text.
  const KNOWN = new Set(['topic', 'policy', 'name', 'text', 'details', 'detail', 'answer', 'policy_text']);
  if (data.length === 1 && !header.some((h) => KNOWN.has(key(h)))) {
    header.forEach((h, j) => { const v = (t[1]?.[j] ?? '').toString().trim(); if (h && v) out.push({ topic: h, text: v }); });
    return out;
  }
  for (const { n, r } of data) {
    const topic = pick(r, 'topic', 'policy', 'name') || Object.values(r)[0] || '';
    const text = pick(r, 'text', 'details', 'detail', 'answer', 'policy_text') || Object.values(r)[1] || '';
    if (!topic || !text) { errors.push(`Policies row ${n}: needs a topic and text`); continue; }
    out.push({ topic, text });
  }
  return out;
}

const NUM_KEYS: Record<string, keyof Settings> = {
  handoff_reply_hours: 'handoffReplyHours', handoff_reply_window_hours: 'handoffReplyHours', batch_seconds: 'batchSeconds', batch_max_seconds: 'batchMaxSeconds',
  typing_base_ms: 'typingBaseMs', typing_ms_per_char: 'typingMsPerChar', typing_min_seconds: 'typingMinSeconds', typing_max_seconds: 'typingMaxSeconds',
  jitter: 'jitter', gap_min_seconds: 'gapMinSeconds', gap_max_seconds: 'gapMaxSeconds', reply_max_seconds: 'replyMaxSeconds',
  human_mode_timeout_hours: 'humanTimeoutHours', human_timeout_hours: 'humanTimeoutHours', followup_days: 'followupDays', retention_months: 'retentionMonths',
};
const BOOL_KEYS: Record<string, keyof Settings> = { bot_enabled: 'botEnabled', shadow_mode: 'shadowMode', shadow_during_studio_hours: 'shadowDuringStudioHours' };
const STR_KEYS: Record<string, keyof Settings> = { studio_hours: 'studioHours', holidays: 'holidays', followup_template: 'followupTemplate', followup_language: 'followupLanguage' };

export function parseSettings(t: Table | undefined, errors: string[]): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const { n, r } of rows(t)) {
    const k = key(pick(r, 'key', 'setting', 'name'));
    const v = pick(r, 'value');
    if (!k) continue;
    if (k in NUM_KEYS) {
      const num = Number(v);
      if (v === '' || !Number.isFinite(num) || num < 0) errors.push(`Settings row ${n}: ${k} must be a number, got "${v}"`);
      else (s as any)[NUM_KEYS[k]!] = num;
    } else if (k in BOOL_KEYS) {
      if (truthy(v)) (s as any)[BOOL_KEYS[k]!] = true;
      else if (falsy(v)) (s as any)[BOOL_KEYS[k]!] = false;
      else errors.push(`Settings row ${n}: ${k} must be TRUE or FALSE, got "${v}"`);
    } else if (k in STR_KEYS) (s as any)[STR_KEYS[k]!] = v;
  }
  if (s.batchMaxSeconds < s.batchSeconds) errors.push('Settings: batch_max_seconds must be >= batch_seconds');
  if (s.typingMaxSeconds < s.typingMinSeconds) errors.push('Settings: typing_max_seconds must be >= typing_min_seconds');
  if (s.jitter > 0.5) errors.push('Settings: jitter must be 0.5 or less');
  try { parseStudioHours(s.studioHours, s.holidays); } catch (e) { errors.push(`Settings: ${(e as Error).message}`); }
  return s;
}

export function parseTeam(t: Table | undefined, errors: string[]): TeamMember[] {
  const out: TeamMember[] = [];
  for (const { n, r } of rows(t)) {
    const name = pick(r, 'name');
    if (!name) { errors.push(`Team row ${n}: name is empty`); continue; }
    out.push({ name, telegram: pick(r, 'telegram_handle', 'telegram').replace(/^@/, ''), role: pick(r, 'role'), onDuty: truthy(pick(r, 'on_duty', 'onduty')) });
  }
  return out;
}

/** All-or-nothing: any validation error means "keep the last good version". */
export function parseBrain(tables: { products?: Table; faq?: Table; policies?: Table; settings?: Table; team?: Table }): ParseResult {
  const errors: string[] = [];
  const products = parseProducts(tables.products, errors);
  const faq = parseFaq(tables.faq, errors);
  const policies = parsePolicies(tables.policies, errors);
  const settings = parseSettings(tables.settings, errors);
  const team = parseTeam(tables.team, errors);
  if (!products.some((p) => p.active)) errors.push('Products: no active products found');
  if (errors.length) return { brain: null, errors };
  return { brain: { products, faq, policies, settings, team, loadedAt: new Date().toISOString() }, errors: [] };
}
