/** Graph API calls to check / turn on "this app receives webhooks for this WhatsApp Business Account". */
export interface SubscribedApp { name?: string; id?: string; override?: string }

type F = typeof fetch;

async function graph(f: F, token: string, url: string, method: 'GET' | 'POST'): Promise<any> {
  const r = await f(url, { method, headers: { Authorization: `Bearer ${token}` } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

export const listSubscribed = async (f: F, token: string, waba: string, v = 'v21.0'): Promise<SubscribedApp[]> => {
  const j = await graph(f, token, `https://graph.facebook.com/${v}/${waba}/subscribed_apps`, 'GET');
  return (j.data ?? []).map((a: any) => ({ name: a.whatsapp_business_api_data?.name ?? a.name, id: a.whatsapp_business_api_data?.id ?? a.id, override: a.override_callback_uri }));
};

export async function subscribeWaba(f: F, token: string, waba: string, v = 'v21.0') {
  const before = await listSubscribed(f, token, waba, v);
  const res = await graph(f, token, `https://graph.facebook.com/${v}/${waba}/subscribed_apps`, 'POST');
  const after = await listSubscribed(f, token, waba, v);
  return { before, after, success: res.success === true };
}
