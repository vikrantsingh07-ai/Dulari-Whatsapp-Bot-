import type { App } from '../app.js';
import type { ToolDef } from './claude.js';
import type { Contact, Conversation } from '../db/repo.js';
import { updateContactProfile, upsertLead, type LeadPatch } from '../db/repo.js';
import { findProducts } from './lookup.js';
import { formatRs } from '../engine/format.js';
import { replyByFor, type PendingHandoff } from '../engine/handoff.js';
import type { Product } from './types.js';
import { unsample } from './prompt.js';

export const TOOLS: ToolDef[] = [
  {
    name: 'lookup_product',
    description: 'Find Dulari products by name, website handle, product link or a short description. Returns the matching rows (price, size, woods, finishes, lead time, stock, link). Use for fuzzy matches and before quoting any detail.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'name, handle, link or description' } }, required: ['query'] },
  },
  {
    name: 'send_product_photo',
    description: 'Queue one real product photo, sent as one of the chat bubbles with a short caption. Send at most 3 per reply. Prefer one photo with a one-line caption over a list.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'product name or handle' },
        photo: { type: 'integer', description: 'which photo, 1 = first (default 1)' },
        caption: { type: 'string', description: 'one short line, plain text' },
      },
      required: ['product'],
    },
  },
  {
    name: 'update_lead',
    description: 'Save what the customer just told you. Call whenever you learn something. Only include fields you actually learned.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['trade', 'project', 'home', 'kids', 'vendor', 'other'] },
        name: { type: 'string' }, language: { type: 'string', description: 'en, hi or hinglish' },
        firm: { type: 'string' }, city: { type: 'string' },
        products: { type: 'array', items: { type: 'string' }, description: 'product names they are interested in' },
        project_type: { type: 'string' }, quantity: { type: 'string' }, timeline: { type: 'string' }, budget: { type: 'string' },
        summary: { type: 'string', description: 'one-line summary of the lead so far' },
      },
    },
  },
  {
    name: 'handoff',
    description: 'Pass this chat to the Dulari team when a handoff rule applies. Returns the honest reply-by time to tell the customer. After calling, tell the customer who will reply and when.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'short reason, e.g. trade pricing, quantity 14, custom size, complaint, catalog_missing' },
        urgency: { type: 'string', enum: ['hot', 'normal'] },
        summary: { type: 'string', description: '3 short lines: who they are, what they want, what they were promised' },
      },
      required: ['reason', 'urgency', 'summary'],
    },
  },
];

/** Side effects the turn wants to apply once the reply is actually committed. */
export interface TurnState {
  photos: { url: string; caption: string }[];
  handoff: PendingHandoff | null;
  shadow: boolean;
}

const productView = (p: Product) => ({
  name: p.name, handle: p.handle, price: p.price > 0 ? formatRs(p.price) : null, size: unsample(p.size) || null, woods: unsample(p.woods) || null,
  finishes: unsample(p.finishes) || null, lead_time: unsample(p.leadTime) || null, in_stock: p.inStock, link: p.productUrl || null, photos_available: p.photoUrls.length, notes: unsample(p.notes) || null,
});

export async function executeTool(app: App, ctx: { conv: Conversation; contact: Contact; turn: TurnState }, name: string, input: any): Promise<{ content: string; isError?: boolean }> {
  const ok = (v: unknown) => ({ content: JSON.stringify(v) });
  const brain = app.brain.get();
  try {
    switch (name) {
      case 'lookup_product': {
        const matches = findProducts(String(input?.query ?? ''), brain.products);
        if (!matches.length) return ok({ matches: [], note: 'No match in the sheet. Do not guess. Say you will check with the team and call handoff.' });
        return ok({ matches: matches.map((m) => productView(m.product)) });
      }
      case 'send_product_photo': {
        if (ctx.turn.photos.length >= 3) return ok({ queued: false, reason: 'already 3 photos queued' });
        const m = findProducts(String(input?.product ?? ''), brain.products, 1)[0];
        if (!m) return ok({ queued: false, reason: 'product not found' });
        let urls = m.product.photoUrls;
        if (!urls.length && app.shopify) urls = await app.shopify.productImages(m.product.handle).catch(() => []);
        if (!urls.length) return ok({ queued: false, reason: 'no photo available for this product' });
        const idx = Math.min(Math.max(Number(input?.photo ?? 1), 1), urls.length) - 1;
        const url = urls[idx]!;
        if (ctx.turn.photos.some((p) => p.url === url)) return ok({ queued: false, reason: 'that photo is already queued' });
        ctx.turn.photos.push({ url, caption: String(input?.caption ?? '').trim() });
        return ok({ queued: true, photo_number: idx + 1 });
      }
      case 'update_lead': {
        const patch: LeadPatch = {};
        for (const k of ['type', 'firm', 'city', 'project_type', 'quantity', 'timeline', 'budget', 'summary'] as const) if (typeof input?.[k] === 'string') patch[k] = input[k];
        if (Array.isArray(input?.products)) patch.products = input.products.filter((p: unknown): p is string => typeof p === 'string');
        await upsertLead(ctx.contact.id, patch);
        if (input?.name || input?.language) await updateContactProfile(ctx.contact.id, { name: input.name, language: input.language });
        return ok({ saved: true });
      }
      case 'handoff': {
        const rb = replyByFor(app);
        ctx.turn.handoff = {
          reason: String(input?.reason ?? 'unspecified'),
          urgency: input?.urgency === 'hot' ? 'hot' : 'normal',
          summary: String(input?.summary ?? ''),
          replyBy: rb.date,
        };
        return ok({
          handed_off: true, reply_by: rb.text, studio_open_now: rb.open,
          say: rb.open ? `The team will reply here by ${rb.text}.` : `The studio is closed right now. The team will reply here by ${rb.text}.`,
        });
      }
      default:
        return { content: `unknown tool ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `tool failed: ${(e as Error).message}`, isError: true };
  }
}
