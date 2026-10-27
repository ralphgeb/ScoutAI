// Scout service — where stocks.json lives.
//
// Prices update every 30 minutes on weekdays. Saving a new copy of stocks.json into the repository
// each time would make it grow by hundreds of megabytes a month, so instead the updater writes it
// straight into the Scout service's KV store on Cloudflare (with the CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID secrets the service already uses). The app and the web app read it from
// https://scout-stocks.ralph-gebara.workers.dev/stocks.json.
//
// If anything goes wrong, the updater falls back to saving stocks.json in the repository as before.

export const SERVICE_URL = process.env.STOCKS_REQUESTS_URL || 'https://scout-stocks.ralph-gebara.workers.dev';
const KV_TITLE = 'scout-stocks-requests';
const KEY = 'file:stocks.json';

const creds = () => {
  const token = (process.env.CLOUDFLARE_API_TOKEN || '').replace(/\s+/g, '');
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID || '').replace(/\s+/g, '');
  return token && account ? { token, account } : null;
};

/** The latest stocks.json from the service, or null. */
export async function readPublishedStocks() {
  try {
    const r = await fetch(`${SERVICE_URL}/stocks.json?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Writes stocks.json to the service. Returns true when it's there. */
export async function publishStocks(data) {
  const c = creds();
  if (!c) return false;
  const api = `https://api.cloudflare.com/client/v4/accounts/${c.account}/storage/kv/namespaces`;
  const headers = { Authorization: `Bearer ${c.token}` };
  try {
    const list = await (await fetch(`${api}?per_page=100`, { headers, signal: AbortSignal.timeout(20000) })).json();
    const ns = (list.result || []).find((n) => n.title === KV_TITLE)?.id;
    if (!ns) return false;
    const r = await fetch(`${api}/${ns}/values/${encodeURIComponent(KEY)}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(60000)
    });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}
