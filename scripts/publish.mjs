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
export const publishStocks = (data) => publishFile('stocks.json', data);

/** Writes a file (stocks.json, prices.json) to the service's KV store. Returns true when it's there. */
export async function publishFile(name, data) {
  const c = creds();
  if (!c) return false;
  const api = `https://api.cloudflare.com/client/v4/accounts/${c.account}/storage/kv/namespaces`;
  const headers = { Authorization: `Bearer ${c.token}` };
  try {
    const list = await (await fetch(`${api}?per_page=100`, { headers, signal: AbortSignal.timeout(20000) })).json();
    const ns = (list.result || []).find((n) => n.title === KV_TITLE)?.id;
    if (!ns) return false;
    const r = await fetch(`${api}/${ns}/values/${encodeURIComponent(`file:${name}`)}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(60000)
    });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}

/** Writes raw bytes (an MP3 of a spoken briefing) to the service's KV store as `file:<name>`. */
export async function publishBinary(name, bytes, type = 'application/octet-stream', ttlDays = 0) {
  const c = creds();
  if (!c) return false;
  const api = `https://api.cloudflare.com/client/v4/accounts/${c.account}/storage/kv/namespaces`;
  const headers = { Authorization: `Bearer ${c.token}` };
  try {
    const list = await (await fetch(`${api}?per_page=100`, { headers, signal: AbortSignal.timeout(20000) })).json();
    const ns = (list.result || []).find((n) => n.title === KV_TITLE)?.id;
    if (!ns) return false;
    const ttl = ttlDays ? `?expiration_ttl=${Math.round(ttlDays * 86400)}` : '';
    const r = await fetch(`${api}/${ns}/values/${encodeURIComponent(`file:${name}`)}${ttl}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': type }, body: bytes, signal: AbortSignal.timeout(60000)
    });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}

/** A JSON file the updater published earlier (audio.json, stats-updater.json), or null. */
export async function readFile(name) {
  const c = creds();
  if (!c) return null;
  const api = `https://api.cloudflare.com/client/v4/accounts/${c.account}/storage/kv/namespaces`;
  const headers = { Authorization: `Bearer ${c.token}` };
  try {
    const list = await (await fetch(`${api}?per_page=100`, { headers, signal: AbortSignal.timeout(20000) })).json();
    const ns = (list.result || []).find((n) => n.title === KV_TITLE)?.id;
    if (!ns) return null;
    const r = await fetch(`${api}/${ns}/values/${encodeURIComponent(`file:${name}`)}`, { headers, signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Adds to this month's and today's counters in stats-updater.json (shown on the service's /stats page). */
export async function addStats(counts) {
  const now = new Date();
  const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  const stats = (await readFile('stats-updater.json')) || { months: {}, days: {} };
  for (const [bucket, key] of [['months', month], ['days', day]]) {
    const b = (stats[bucket][key] ||= {});
    for (const [k, v] of Object.entries(counts)) b[k] = (b[k] || 0) + (Number(v) || 0);
  }
  // keep 62 days of daily numbers
  stats.days = Object.fromEntries(Object.entries(stats.days).sort().slice(-62));
  stats.updated = now.toISOString();
  return publishFile('stats-updater.json', stats);
}
