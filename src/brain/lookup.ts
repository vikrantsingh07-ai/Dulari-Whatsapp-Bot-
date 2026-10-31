import type { Product } from './types.js';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => norm(s).split(/[\s-]+/).filter((t) => t.length > 1);

export function handleFromUrl(text: string): string | null {
  const m = text.match(/\/products\/([a-z0-9][a-z0-9-_]*)/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** "Hi, I would like to inquire about: Daily Table https://dulari.design/products/mini-table" */
export function parseEnquire(text: string): { productText: string; handle: string | null; url: string | null } | null {
  const m = text.match(/inquire about:?\s*(.*)$/is);
  if (!m) return null;
  const rest = m[1]!.trim();
  const url = rest.match(/https?:\/\/\S+/)?.[0] ?? null;
  const productText = rest.replace(/https?:\/\/\S+/g, '').trim();
  return { productText, handle: url ? handleFromUrl(url) : handleFromUrl(rest), url };
}

export interface Match { product: Product; score: number }

export function findProducts(query: string, products: Product[], limit = 3): Match[] {
  const handle = handleFromUrl(query);
  const q = norm(query.replace(/https?:\/\/\S+/g, ''));
  const qt = new Set(tokens(q));
  const out: Match[] = [];
  for (const p of products) {
    if (!p.active) continue;
    let score = 0;
    const names = [p.name, ...p.otherNames].map(norm).filter(Boolean);
    if (handle && p.handle.toLowerCase() === handle) score = 100;
    else if (p.handle.toLowerCase() === q.replace(/\s/g, '-')) score = 98;
    else if (names.includes(q)) score = 90;
    else if (q && names.some((n) => n.includes(q) || (n.length > 3 && q.includes(n)))) score = 70;
    else if (qt.size) {
      for (const n of names) {
        const nt = tokens(n);
        if (!nt.length) continue;
        const hit = nt.filter((t) => qt.has(t)).length;
        score = Math.max(score, (hit / Math.max(nt.length, qt.size)) * 60);
      }
    }
    if (score >= 30) out.push({ product: p, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
