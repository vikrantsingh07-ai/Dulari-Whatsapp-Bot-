import type { Config } from '../config.js';

/**
 * Read-only Shopify Admin API (scope read_products). Uses the client-credentials flow
 * required for apps created in the Dev Dashboard since 2026-01-01.
 * Only used to fetch product images by handle; sheet photo URLs take priority.
 */
export class ShopifyClient {
  private token: { value: string; expires: number } | null = null;
  private cache = new Map<string, { urls: string[]; at: number }>();
  constructor(private cfg: Pick<Config, 'SHOPIFY_SHOP_DOMAIN' | 'SHOPIFY_CLIENT_ID' | 'SHOPIFY_CLIENT_SECRET'>, private fetchImpl: typeof fetch = fetch) {}

  static maybeCreate(cfg: Config): ShopifyClient | null {
    return cfg.SHOPIFY_SHOP_DOMAIN && cfg.SHOPIFY_CLIENT_ID && cfg.SHOPIFY_CLIENT_SECRET ? new ShopifyClient(cfg) : null;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://${this.cfg.SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.cfg.SHOPIFY_CLIENT_ID, client_secret: this.cfg.SHOPIFY_CLIENT_SECRET }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`shopify token: HTTP ${res.status}`);
    this.token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 86_000) * 1000 };
    return this.token.value;
  }

  async productImages(handle: string): Promise<string[]> {
    const hit = this.cache.get(handle);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.urls;
    const res = await this.fetchImpl(`https://${this.cfg.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.accessToken() },
      body: JSON.stringify({
        query: 'query($h:String!){ productByHandle(handle:$h){ images(first:5){ nodes{ url } } } }',
        variables: { h: handle },
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j.errors) throw new Error(`shopify query: ${res.status} ${JSON.stringify(j.errors ?? '')}`);
    const urls: string[] = (j.data?.productByHandle?.images?.nodes ?? []).map((n: any) => n.url).filter(Boolean);
    this.cache.set(handle, { urls, at: Date.now() });
    return urls;
  }
}
