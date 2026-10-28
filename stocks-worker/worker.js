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
//   GET  /prices.json                           → prices for ~3,500 stocks and yesterday's risers and fallers
//   GET  /news.json, /briefing.json             → the latest news and briefing, fresh within a minute
//                                                 (GitHub's own file server can lag by five minutes)
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

// Metro status for New York (MTA, no key needed) and Paris (Île-de-France Mobilités' PRIM, needs the
// free PRIM_API_KEY secret), fetched once every two minutes for everyone and boiled down to a short
// list of lines, like TfL's for London (which phones read from TfL directly).
//   GET /transit/nyc, GET /transit/paris
//   → {"city": "nyc", "updated": "…", "source": "MTA", "lines": [{"id": "A", "name": "A train",
//      "short": "A", "colour": "#0039A6", "text": "#FFFFFF", "level": 1, "status": "Delays", "reason": "…"}]}
// level: 0 good service, 1 minor problems or planned works, 2 severe (suspended, part closed).
const TRANSIT_TTL = 120;            // seconds

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

    if (["/stocks.json", "/prices.json", "/news.json", "/briefing.json"].includes(url.pathname) && request.method === "GET") {
      const name = url.pathname.slice(1);
      const cache = caches.default;
      const key = new Request(`https://files.scout/${name}`);
      const hit = await cache.match(key);
      if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60", ...cors() } });
      const body = await env.REQUESTS.get(`file:${name}`);
      if (!body) return json({ error: "Not published yet" }, 404);
      await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" } }));
      return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60", ...cors() } });
    }

    if (url.pathname === "/weather" && request.method === "GET") {
      return weather(url, request, env);
    }

    const transitCity = url.pathname.match(/^\/transit\/(nyc|paris)$/)?.[1];
    if (transitCity && request.method === "GET") {
      if (transitCity === "paris" && url.searchParams.get("debug") === "1") return json(await parisDebug(env));
      return transit(transitCity, env);
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

    return json({ service: "Scout", endpoints: ["POST /add", "GET /list", "GET /stocks.json", "GET /prices.json", "GET /weather?lat=&lon=&tz=", "GET /transit/nyc", "GET /transit/paris"] });
  },

  // Every 10 minutes: ask ScoutAI's workflow to do whatever is due (the 6:00 briefing, prices every
  // 30 minutes, the morning notification), because GitHub's own schedule often skips most of its
  // runs. And start the quick update if stocks were added while the last one was recent.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([dispatch(env, { mode: "auto" }), runIfDue(env)]));
  },
};

/** Starts ScoutAI's update workflow with these inputs. */
async function dispatch(env, inputs) {
  if (!env.DISPATCH_TOKEN) return false;
  const r = await fetch(WORKFLOW, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "scout-stocks",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  return r.ok;
}

/** Starts ScoutAI's quick stocks update when something is waiting and the last run was 10+ minutes ago. */
async function runIfDue(env) {
  if (!env.DISPATCH_TOKEN) return false;
  if (!(await env.REQUESTS.get("run:pending"))) return false;
  const last = await env.REQUESTS.get("run:last");
  if (last && Date.now() - Date.parse(last) < RUN_GAP_MS) return false;
  if (!(await dispatch(env, { mode: "stocks", briefing: "no" }))) return false;
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

// MARK: - Metro status

const W = "#FFFFFF", K = "#000000";
const NYC_LINES = [
  ["1", "#EE352E", W], ["2", "#EE352E", W], ["3", "#EE352E", W], ["4", "#00933C", W], ["5", "#00933C", W],
  ["6", "#00933C", W], ["7", "#B933AD", W], ["A", "#0039A6", W], ["C", "#0039A6", W], ["E", "#0039A6", W],
  ["B", "#FF6319", W], ["D", "#FF6319", W], ["F", "#FF6319", W], ["M", "#FF6319", W], ["G", "#6CBE45", W],
  ["J", "#996633", W], ["Z", "#996633", W], ["L", "#A7A9AC", W], ["N", "#FCCC0A", K], ["Q", "#FCCC0A", K],
  ["R", "#FCCC0A", K], ["W", "#FCCC0A", K], ["S", "#808183", W], ["SIR", "#0F2D6B", W],
].map(([id, colour, text]) => ({ id, short: id, name: id === "SIR" ? "Staten Island Railway" : id === "S" ? "Shuttles" : `${id} train`, colour, text }));

const PARIS_LINES = [
  ["1", "#FFCD00", K], ["2", "#003CA6", W], ["3", "#837902", W], ["3bis", "#6EC4E8", K], ["4", "#CF009E", W],
  ["5", "#FF7E2E", K], ["6", "#6ECA97", K], ["7", "#FA9ABA", K], ["7bis", "#6ECA97", K], ["8", "#E19BDF", K],
  ["9", "#B6BD00", K], ["10", "#C9910D", K], ["11", "#704B1C", W], ["12", "#007852", W], ["13", "#6EC4E8", K],
  ["14", "#62259D", W], ["A", "#E2231A", W], ["B", "#5291CE", W], ["C", "#FFCE00", K], ["D", "#00814F", W],
  ["E", "#C04191", W],
].map(([id, colour, text]) => ({ id, short: id.replace("bis", "b"), name: /^[A-E]$/.test(id) ? `RER ${id}` : `Line ${id.replace("bis", " bis")}`, colour, text }));

async function transit(city, env) {
  const cache = caches.default;
  const key = new Request(`https://transit.scout/${city}`);
  const staleKey = new Request(`https://transit.scout/${city}/stale`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json", "X-Scout-Cache": "hit", ...cors() } });

  let lines;
  try {
    lines = city === "nyc" ? await newYork() : await paris(env);
  } catch (e) {
    // TfL-style feeds go down now and then: hand out the last good answer for up to an hour.
    const stale = await cache.match(staleKey);
    if (stale) return new Response(stale.body, { headers: { "Content-Type": "application/json", "X-Scout-Cache": "stale", ...cors() } });
    return json({ error: String(e.message || e) }, city === "paris" && !env.PRIM_API_KEY ? 503 : 502);
  }
  const body = JSON.stringify({ city, updated: new Date().toISOString(), source: city === "nyc" ? "MTA" : "Île-de-France Mobilités", lines });
  await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${TRANSIT_TTL}` } }));
  await cache.put(staleKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" } }));
  return new Response(body, { headers: { "Content-Type": "application/json", "X-Scout-Cache": "miss", ...cors() } });
}

/** Every line with its worst current problem, worst lines first. */
function summarise(all, problems) {
  return all.map((line) => {
    const mine = problems.get(line.id) || [];
    const level = Math.max(0, ...mine.map((p) => p.level));
    const statuses = [...new Set(mine.filter((p) => p.level === level).map((p) => p.status))];
    const reasons = [...new Set(mine.filter((p) => p.reason).sort((a, b) => b.level - a.level).map((p) => p.reason))].slice(0, 3);
    return { ...line, level, status: level ? statuses.slice(0, 2).join(" · ") : "Good service", reason: level ? reasons.join("\n\n") : "" };
  });
}

function add(problems, id, problem) {
  if (!problems.has(id)) problems.set(id, []);
  problems.get(id).push(problem);
}

function plain(html, max = 420) {
  const t = String(html || "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// New York: the MTA's subway alerts, in GTFS-realtime's JSON form.
async function newYork() {
  const r = await fetch("https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json", { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error(`MTA answered ${r.status}`);
  const data = await r.json();
  const now = Date.now() / 1000;
  const route = (id) => ({ "6X": "6", "7X": "7", FX: "F", GS: "S", FS: "S", H: "S", SI: "SIR", SS: "SIR" })[id] || id;
  const known = new Set(NYC_LINES.map((l) => l.id));
  const problems = new Map();
  for (const e of data.entity || []) {
    const a = e.alert;
    if (!a) continue;
    const periods = a.active_period || [];
    const active = !periods.length || periods.some((p) => Number(p.start || 0) <= now && (!Number(p.end) || Number(p.end) > now));
    if (!active) continue;
    const type = a["transit_realtime.mercury_alert"]?.alert_type || "Service change";
    const level = nycLevel(type);
    if (!level) continue;
    const en = (a.header_text?.translation || []).find((t) => t.language === "en") || a.header_text?.translation?.[0];
    const reason = plain(en?.text).replace(/\[(\w+)\]/g, "$1");
    const status = type.replace(/^Planned\s*-\s*/i, "Planned: ");
    for (const ie of a.informed_entity || []) {
      const id = route(ie.route_id);
      if (known.has(id)) add(problems, id, { level, status, reason });
    }
  }
  return summarise(NYC_LINES, problems);
}

function nycLevel(type) {
  const t = type.toLowerCase();
  if (/station notice|special schedule|information|boarding change|extra service|weekday service|weekend service/.test(t)) return 0;
  if (/severe|suspend|no (scheduled )?service|no trains/.test(t) && !/part/.test(t)) return 2;
  return 1;
}

// Paris: metro and RER disruptions from PRIM's line reports (Navitia), active ones only.
async function paris(env) {
  if (!env.PRIM_API_KEY) throw new Error("Paris isn't set up yet (PRIM_API_KEY)");
  const modes = ["physical_mode:Metro", "physical_mode:RapidTransit"];
  const answers = await Promise.all(modes.map(async (m) => {
    const r = await fetch(`https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/line_reports/physical_modes/${encodeURIComponent(m)}/line_reports?count=100&disable_geojson=true`,
      { headers: { apikey: env.PRIM_API_KEY.trim(), Accept: "application/json" } });
    if (!r.ok) throw new Error(`PRIM answered ${r.status}`);
    return r.json();
  }));
  const known = new Map(PARIS_LINES.map((l) => [l.id.toLowerCase(), l.id]));
  const lineId = (code) => known.get(String(code || "").toLowerCase().replace(/\s+/g, "").replace(/b$/, "bis")) || known.get(String(code || "").toLowerCase());
  const problems = new Map();
  for (const data of answers) {
    const disruptions = new Map((data.disruptions || []).map((d) => [d.id, d]));
    for (const report of data.line_reports || []) {
      const id = lineId(report.line?.code || report.line?.name);
      if (!id) continue;
      for (const did of disruptionLinks(report)) {
        const d = disruptions.get(did);
        if (!d || (d.status && d.status !== "active")) continue;
        const level = parisLevel(d);
        if (!level) continue;
        const title = (d.messages || []).find((m) => (m.channel?.types || []).includes("title"))?.text;
        const text = title || (d.messages || [])[0]?.text;
        const works = /travaux/i.test(d.cause || "") || (d.tags || []).some((t) => /travaux/i.test(t));
        const status = level === 2 ? (works ? "Part closed, planned works" : "Severe disruption") : (works ? "Planned works" : "Disrupted");
        add(problems, id, { level, status, reason: plain(text) });
      }
    }
  }
  return summarise(PARIS_LINES, problems);
}

/** Every disruption a line report points to, on the line itself or on its stops. */
function disruptionLinks(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => disruptionLinks(n, out));
  else if (node && typeof node === "object") {
    if (node.type === "disruption" && node.id) out.add(node.id);
    for (const v of Object.values(node)) if (v && typeof v === "object") disruptionLinks(v, out);
  }
  return out;
}

function parisLevel(d) {
  const name = String(d.severity?.name || "").toLowerCase();
  if (/bloquant/.test(name)) return 2;
  if (/perturb/.test(name)) return 1;
  if (/information/.test(name)) return 0;
  const effect = String(d.severity?.effect || d.severity || "").toUpperCase();
  if (/NO_SERVICE|BLOQUANT/.test(effect)) return 2;
  if (/SIGNIFICANT_DELAYS|REDUCED_SERVICE|DETOUR|MODIFIED_SERVICE|STOP_MOVED|PERTURB/.test(effect)) return 1;
  if (/ADDITIONAL_SERVICE|INFORMATION|UNKNOWN_EFFECT|OTHER_EFFECT/.test(effect)) return 0;
  return 1;
}

/** What PRIM says for each line, for checking how its disruptions are read. Not cached. */
async function parisDebug(env) {
  if (!env.PRIM_API_KEY) return { error: "no key" };
  const out = [];
  for (const m of ["physical_mode:Metro", "physical_mode:RapidTransit"]) {
    const r = await fetch(`https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/line_reports/physical_modes/${encodeURIComponent(m)}/line_reports?count=100&disable_geojson=true`,
      { headers: { apikey: env.PRIM_API_KEY.trim(), Accept: "application/json" } });
    const data = await r.json();
    const disruptions = new Map((data.disruptions || []).map((d) => [d.id, d]));
    for (const report of data.line_reports || []) {
      const onLine = new Set((report.line?.links || []).filter((l) => l.type === "disruption").map((l) => l.id));
      const objects = (report.pt_objects || []).map((o) => ({ type: o.embedded_type, ids: [...disruptionLinks(o)] }));
      const all = disruptionLinks(report);
      out.push({ line: report.line?.code, name: report.line?.name, onLine: onLine.size, objectTypes: [...new Set(objects.map((o) => o.type))],
        disruptions: [...all].map((id) => { const d = disruptions.get(id) || {}; return {
          where: onLine.has(id) ? "line" : (objects.find((o) => o.ids.includes(id))?.type || "?"), status: d.status,
          severity: d.severity?.name, effect: d.severity?.effect, cause: d.cause, tags: d.tags, category: d.category,
          title: plain((d.messages || []).find((x) => (x.channel?.types || []).includes("title"))?.text || d.messages?.[0]?.text, 90),
          impacted: (d.impacted_objects || []).map((i) => i.pt_object?.embedded_type).slice(0, 3) }; }) });
    }
  }
  return out;
}
