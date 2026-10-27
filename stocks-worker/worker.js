// Scout's shared list of followed stocks.
//
// When someone adds a stock in the Scout iPhone app, the app tells this service. The morning
// update (scripts/update-news.mjs) reads the list and writes an AI summary for each stock, so a
// stock anyone follows gets one. Each stock stays on the list for 45 days after anyone last
// asked for it (the app asks again once a day for the stocks you follow), then drops off by itself.
//
//   POST /add   {"symbols": ["AAPL", "BARC.L"]}  → adds or refreshes them
//   GET  /list                                  → {"symbols": [{"symbol": "AAPL", "requested": "…"}]}
//   GET  /stocks.json                           → the latest prices, AI summaries and headlines
//
// Prices: the ScoutAI updater writes stocks.json every 30 minutes on weekdays straight into this
// service's KV store (with the Cloudflare key it already has), instead of saving a new copy into the
// repository each time. Phones and the web app read it from here, cached at the edge for a minute.
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

// Shared weather: one Apple WeatherKit call per area (about 5 km) every 30 minutes, handed to
// everyone nearby from Cloudflare's cache, so WeatherKit's monthly allowance goes much further.
//   GET /weather?lat=51.51&lon=-0.13&tz=Europe/London
// Needs the WEATHERKIT_KEY_ID, WEATHERKIT_PRIVATE_KEY and APPLE_TEAM_ID secrets; without them it
// answers 503 and the app asks WeatherKit itself.
const WEATHER_GRID = 0.05;          // degrees: about 5.5 km north–south
const WEATHER_TTL = 30 * 60;        // seconds
const WEATHER_PER_IP_PER_DAY = 300;

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

    if (url.pathname === "/stocks.json" && request.method === "GET") {
      const cache = caches.default;
      const key = new Request("https://files.scout/stocks.json");
      const hit = await cache.match(key);
      if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60", ...cors() } });
      const body = await env.REQUESTS.get("file:stocks.json");
      if (!body) return json({ error: "Not published yet" }, 404);
      await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } }));
      return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60", ...cors() } });
    }

    if (url.pathname === "/weather" && request.method === "GET") {
      return weather(url, request, env);
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

    return json({ service: "Scout", endpoints: ["POST /add", "GET /list", "GET /stocks.json", "GET /weather?lat=&lon=&tz="] });
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

// MARK: - Shared weather

async function weather(url, request, env) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  const tz = (url.searchParams.get("tz") || "Europe/London").replace(/[^A-Za-z0-9_+\-\/]/g, "").slice(0, 40);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "Bad location" }, 400);
  if (!env.WEATHERKIT_KEY_ID || !env.WEATHERKIT_PRIVATE_KEY || !env.APPLE_TEAM_ID) return json({ error: "Weather not set up" }, 503);

  // Everyone in the same ~5 km square shares one answer.
  const glat = (Math.round(lat / WEATHER_GRID) * WEATHER_GRID).toFixed(2);
  const glon = (Math.round(lon / WEATHER_GRID) * WEATHER_GRID).toFixed(2);
  const cache = caches.default;
  const key = new Request(`https://weather.scout/${glat}/${glon}/${encodeURIComponent(tz)}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json", "X-Scout-Cache": "hit", ...cors() } });

  // Only misses count towards the per-address limit.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = new Request(`https://rate.scout/weather/${encodeURIComponent(ip)}/${new Date().toISOString().slice(0, 10)}`);
  const used = Number((await (await cache.match(rateKey))?.text()) || 0);
  if (used >= WEATHER_PER_IP_PER_DAY) return json({ error: "Too many today" }, 429);
  await cache.put(rateKey, new Response(String(used + 1), { headers: { "Cache-Control": "max-age=86400" } }));

  let data;
  try {
    const token = await weatherToken(env);
    const api = `https://weatherkit.apple.com/api/v1/weather/en/${glat}/${glon}?dataSets=currentWeather,forecastHourly,forecastDaily&timezone=${encodeURIComponent(tz)}`;
    const r = await fetch(api, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return json({ error: `WeatherKit answered ${r.status}` }, 502);
    data = await r.json();
  } catch (e) {
    return json({ error: "WeatherKit failed" }, 502);
  }

  // Only what the app shows: now, today's high and low, and the next 25 hours.
  const lower = (c) => (c ? c[0].toLowerCase() + c.slice(1) : "cloudy");
  const now = Date.now();
  const cw = data.currentWeather || {};
  const today = data.forecastDaily?.days?.[0] || {};
  const hours = (data.forecastHourly?.hours || [])
    .filter((h) => Date.parse(h.forecastStart) > now - 3600e3)
    .slice(0, 25)
    .map((h) => ({ t: h.forecastStart, temp: h.temperature, cond: lower(h.conditionCode), day: !!h.daylight,
                   rain: Math.round((h.precipitationChance || 0) * 100) }));
  const body = JSON.stringify({
    fetched: new Date().toISOString(),
    current: { temp: cw.temperature, cond: lower(cw.conditionCode), day: !!cw.daylight },
    high: today.temperatureMax ?? null, low: today.temperatureMin ?? null,
    rain: today.precipitationChance != null ? Math.round(today.precipitationChance * 100) : null,
    hours,
  });
  await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${WEATHER_TTL}` } }));
  return new Response(body, { headers: { "Content-Type": "application/json", "X-Scout-Cache": "miss", ...cors() } });
}

/** A short-lived signed key for WeatherKit's web service (ES256, from the .p8 key). */
async function weatherToken(env) {
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const text = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const service = env.WEATHERKIT_SERVICE_ID || "com.ralphgeb.scout";
  const iat = Math.floor(Date.now() / 1000);
  const head = text({ alg: "ES256", kid: env.WEATHERKIT_KEY_ID.trim(), id: `${env.APPLE_TEAM_ID.trim()}.${service}` });
  const claims = text({ iss: env.APPLE_TEAM_ID.trim(), iat, exp: iat + 3600, sub: service });
  const pem = env.WEATHERKIT_PRIVATE_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}
