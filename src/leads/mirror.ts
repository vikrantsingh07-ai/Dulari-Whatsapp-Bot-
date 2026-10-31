import type { SheetsClient } from '../brain/sheets.js';
import { leadsForMirror } from '../db/repo.js';

const HEADER = ['updated_at', 'phone', 'name', 'type', 'firm', 'city', 'products', 'project_type', 'quantity', 'timeline', 'budget', 'source', 'status', 'hot', 'owner', 'bot_mode', 'summary'];

/** Postgres is the source of truth; this rewrites the "Dulari Leads" sheet from it. */
export class LeadsMirror {
  constructor(private sheets: SheetsClient, private sheetId: string, private tab = 'Leads') {}
  async run(): Promise<number> {
    const rows = await leadsForMirror();
    const values = [
      HEADER,
      ...rows.map((r) => [
        r.updated_at.toISOString(), `+${r.wa_id}`, r.name ?? '', r.type ?? '', r.firm ?? '', r.city ?? '', (r.products ?? []).join(', '),
        r.project_type ?? '', r.quantity ?? '', r.timeline ?? '', r.budget ?? '', r.source ?? '', r.status, r.hot ? 'HOT' : '', r.owner ?? '', r.bot_mode ?? '', r.summary ?? '',
      ]),
    ];
    await this.sheets.replaceTab(this.sheetId, this.tab, values);
    return rows.length;
  }
}
