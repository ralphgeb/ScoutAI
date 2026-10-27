// Scout's shared list of followed stocks.
//
// When someone adds a stock in the Scout iPhone app, the app tells this service. The morning
// update (scripts/update-news.mjs) reads the list and writes an AI summary for each stock, so a
// stock anyone follows gets one. Each stock stays on the list for 45 days after anyone last
// asked for it (the app asks again once a day for the stocks you follow), then drops off by itself.
//
//   POST /add   {"symbols": ["AAPL", "BARC.L"]}  → adds or refreshes them
//   GET  /list                                  → {"symbols": [{"symbol": "AAPL", "requested": "…"}]}
//
// Free to run: Cloudflare's free Workers plan stops rather than bills, and the updater caps how
// many of these stocks get AI summaries, so the AI cost stays small however many people use it.
//
// Quick summaries: when a stock nobody had asked for before is added, this starts ScoutAI's quick
// "stocks" update (it summarises only stocks without a summary yet), so the summary arrives within
// minutes instead of the next morning. At most one run every 10 minutes; anything added in between
// waits for the next one, which a 10-minute timer starts. Needs the DISPATCH_TOKEN secret (a GitHub
// key that can start workflows in ScoutAI); without it, new stocks wait for the morning update.

const KEEP_DAYS = 45;
const PER_REQUEST = 40;            // symbols in one request
const PER_IP_PER_DAY = 60;         // symbols one address can add in a day
const VALID = /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/;
const RUN_GAP_MS = 10 * 60e3;      // at most one quick update every 10 minutes
const WORKFLOW = "https://api.github.com/repos/ralphgeb/ScoutAI/actions/workflows/update-news.yml/dispatches";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    if (url.pathname === "/add" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Expected JSON" }, 400); }
      const symbols = [...new Set((Array.isArray(body?.symbols) ? body.symbols : [])
        .map((s) => String(s).trim().toUpperCase()).filter((s) => VALID.test(s)))].slice(0, PER_REQUEST);
      if (!symbols.length) return json({ error: "No valid symbols" }, 400);

      // A light per-address limit, kept in Cloudflare's cache (free, no KV writes).
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const day = new Date().toISOString().slice(0, 10);
      const rateKey = new Request(`https://rate.scout/${encodeURIComponent(ip)}/${day}`);
      const cache = caches.default;
      const used = Number((await (await cache.match(rateKey))?.text()) || 0);
      if (used + symbols.length > PER_IP_PER_DAY) return json({ error: "Too many today" }, 429);
      await cache.put(rateKey, new Response(String(used + symbols.length), { headers: { "Cache-Control": "max-age=86400" } }));

      // Write only what's new or not refreshed for a day, to stay well inside the free KV limits.
      const now = new Date().toISOString();
      let added = 0, brandNew = 0;
      for (const s of symbols) {
        const last = await env.REQUESTS.get(`s:${s}`);
        if (last && Date.now() - Date.parse(last) < 20 * 3600e3) continue;
        await env.REQUESTS.put(`s:${s}`, now, { expirationTtl: KEEP_DAYS * 86400, metadata: { requested: now } });
        added++;
        if (!last) brandNew++;
      }
      let summarising = false;
      if (brandNew && env.DISPATCH_TOKEN) {
        await env.REQUESTS.put("run:pending", now, { expirationTtl: 86400 });
        summarising = await runIfDue(env);
      }
      return json({ ok: true, symbols, refreshed: added, summarising: summarising || (brandNew > 0 && !!env.DISPATCH_TOKEN) });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const out = [];
      let cursor;
      do {
        const page = await env.REQUESTS.list({ prefix: "s:", cursor });
        for (const k of page.keys) out.push({ symbol: k.name.slice(2), requested: k.metadata?.requested || null });
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      out.sort((a, b) => String(b.requested).localeCompare(String(a.requested)));
      return json({ symbols: out });
    }

    return json({ service: "Scout stocks", endpoints: ["POST /add", "GET /list"] });
  },

  // Every 10 minutes: start the quick update if stocks were added while the last one was recent.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIfDue(env));
  },
};

/** Starts ScoutAI's quick stocks update when something is waiting and the last run was 10+ minutes ago. */
async function runIfDue(env) {
  if (!env.DISPATCH_TOKEN) return false;
  if (!(await env.REQUESTS.get("run:pending"))) return false;
  const last = await env.REQUESTS.get("run:last");
  if (last && Date.now() - Date.parse(last) < RUN_GAP_MS) return false;
  const r = await fetch(WORKFLOW, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "scout-stocks",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { mode: "stocks", briefing: "no" } }),
  });
  if (!r.ok) return false;
  await env.REQUESTS.put("run:last", new Date().toISOString(), { expirationTtl: 86400 });
  await env.REQUESTS.delete("run:pending");
  return true;
}

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors() } });
}
