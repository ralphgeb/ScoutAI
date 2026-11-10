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
//   GET  /audio.json, /audio/<Section>-<chirp|intro>.mp3 → the spoken briefings
//   GET  /audio/story/<id>.mp3                → a story read aloud (recorded the first time anyone plays it)
//   POST /stats/play {kind, id, title}          → counts a play;  GET /stats → the numbers page
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

    // spoken briefings: /audio/Tech-chirp.mp3 (the MP3s the updater records each morning)
    const story = url.pathname.match(/^\/audio\/story\/([A-Za-z0-9_-]{4,64})\.mp3$/);
    if (story && (request.method === "GET" || request.method === "HEAD")) {
      return storyAudio(story[1], env);
    }

    if (url.pathname === "/stats/play" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* counted anyway */ }
      await countPlay(env, String(body.kind || "story").slice(0, 20), String(body.id || "").slice(0, 64), String(body.title || "").slice(0, 160));
      return json({ ok: true });
    }

    if (url.pathname === "/stats" && request.method === "GET") {
      return statsPage(env);
    }

    const audio = url.pathname.match(/^\/audio\/(?:(Tech|Finance|World|Fashion)-(standard|wavenet|chirp|intro)|sample-([A-Za-z]+(?:-[A-Z])?)|hold-([0-9]))\.mp3$/);
    if (audio && (request.method === "GET" || request.method === "HEAD")) {
      const name = audio[4] ? `audio-hold-${audio[4]}.mp3` : audio[3] ? `audio-sample-${audio[3]}.mp3` : `audio-${audio[1]}-${audio[2]}.mp3`;
      const cache = caches.default;
      const key = new Request(`https://files.scout/${name}`);
      const hit = await cache.match(key);
      const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=300", "Accept-Ranges": "bytes", ...cors() };
      if (hit) return new Response(hit.body, { headers });
      const body = await env.REQUESTS.get(`file:${name}`, "arrayBuffer");
      if (!body) return json({ error: "Not recorded yet" }, 404);
      await cache.put(key, new Response(body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=300" } }));
      return new Response(body, { headers });
    }

    if (["/stocks.json", "/prices.json", "/news.json", "/briefing.json", "/audio.json"].includes(url.pathname) && request.method === "GET") {
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

    // a page to hear the Chirp 3: HD voices side by side and pick one
    if (url.pathname === "/voices" && request.method === "GET") {
      const list = (await env.REQUESTS.get("file:audio-samples.json", "json"))?.samples || [];
      const tiers = [...new Set(list.map((s) => s.tier || "Chirp 3: HD"))];
      const rows = tiers.map((t) => `<h2>${t}</h2>` + list.filter((s) => (s.tier || "Chirp 3: HD") === t)
        .map((s) => `<div class="v"><b>${s.voice.replace(/^(Standard|Wavenet)-/, "")}</b> <span>${s.mood || ""}</span><audio controls preload="none" src="${s.path}"></audio></div>`).join("")).join("") || "<p>No samples recorded yet.</p>";
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout voices</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0 auto;max-width:560px;padding:20px 16px;background:#faf8f5;color:#1c1b19}h1{font-size:24px}h2{font-size:18px;margin-top:26px}.v{background:#fff;border-radius:14px;padding:14px;margin:10px 0}.v span{color:#888}audio{width:100%;margin-top:8px}@media(prefers-color-scheme:dark){body{background:#151413;color:#eee}.v{background:#242220}}</style>
<h1>Scout voices</h1><p>The start of today's Tech briefing in each voice.</p>${rows}`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if (["/privacy", "/terms", "/support"].includes(url.pathname) && request.method === "GET") {
      return page(url.pathname.slice(1));
    }

    const transitCity = url.pathname.match(/^\/transit\/(nyc|paris)$/)?.[1];
    if (transitCity && request.method === "GET") {
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

// MARK: - Stories read aloud, on demand

// The updater records the day's top 15 stories ahead. Any other story is recorded the first time
// someone presses play (with Google's Chirp 3: HD voice Aoede, the same as the briefings), kept for
// 10 days, and played from the store to everyone after that. A daily cap keeps the cost in check:
// past it, the app reads the story with the phone's own voice instead.
const STORY_VOICE = "en-GB-Chirp3-HD-Aoede";
const STORY_RATE = 1.05;
const STORY_DAYS = 10;
const DAILY_STORY_CHARS = 30000;   // about 30 stories a day recorded on demand

async function storyAudio(id, env) {
  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=86400", ...cors() };
  const name = `file:audio-story-${id}.mp3`;
  const cache = caches.default;
  const key = new Request(`https://files.scout/story-${id}.mp3`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers });
  let body = await env.REQUESTS.get(name, "arrayBuffer");
  if (!body) {
    if (!env.GOOGLE_TTS_KEY) return json({ error: "Story audio is off" }, 503);
    const news = await env.REQUESTS.get("file:news.json", "json");
    const st = (news?.stories || []).find((x) => x.id === id);
    if (!st) return json({ error: "No such story" }, 404);
    const points = (st.key_points || []).map((k) => (typeof k === "string" ? k : k?.text || k?.line || "")).filter(Boolean);
    const text = [st.headline, st.summary || st.claim || "", ...points].filter(Boolean).join("\n\n").slice(0, 4500);
    const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
    const used = Number(await env.REQUESTS.get(`stat:${day}:chars_on_demand`)) || 0;
    if (used + text.length > DAILY_STORY_CHARS) return json({ error: "Daily limit reached" }, 429);
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text }, voice: { languageCode: "en-GB", name: STORY_VOICE }, audioConfig: { audioEncoding: "MP3", speakingRate: STORY_RATE } }),
    });
    if (!r.ok) return json({ error: `Google answered ${r.status}` }, 502);
    const b64 = (await r.json()).audioContent || "";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    body = bytes.buffer;
    await env.REQUESTS.put(name, body, { expirationTtl: STORY_DAYS * 86400 });
    await bump(env, `stat:${day}:chars_on_demand`, text.length, 3 * 86400);
    await bump(env, `stat:${month}:chars_on_demand`, text.length, 400 * 86400);
    await bump(env, `stat:${month}:stories_recorded_on_demand`, 1, 400 * 86400);
  }
  await cache.put(key, new Response(body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=86400" } }));
  return new Response(body, { headers });
}

async function bump(env, key, by, ttl) {
  const n = (Number(await env.REQUESTS.get(key)) || 0) + by;
  await env.REQUESTS.put(key, String(n), { expirationTtl: ttl });
  return n;
}

// MARK: - Numbers (/stats)

async function countPlay(env, kind, id, title) {
  const month = new Date().toISOString().slice(0, 7);
  await bump(env, `stat:${month}:plays_${kind}`, 1, 400 * 86400);
  if (!id) return;
  const key = `play:${month}:${kind}:${id}`;
  const n = (Number(await env.REQUESTS.get(key)) || 0) + 1;
  await env.REQUESTS.put(key, String(n), { expirationTtl: 400 * 86400, metadata: { n, title } });
}

async function statsPage(env) {
  const month = new Date().toISOString().slice(0, 7);
  const updater = (await env.REQUESTS.get("file:stats-updater.json", "json")) || { months: {}, days: {} };
  const u = updater.months?.[month] || {};
  const get = async (k) => Number(await env.REQUESTS.get(`stat:${month}:${k}`)) || 0;
  const [demandChars, demandStories, storyPlays, briefingPlays] = await Promise.all(
    ["chars_on_demand", "stories_recorded_on_demand", "plays_story", "plays_briefing"].map(get));
  const plays = await env.REQUESTS.list({ prefix: `play:${month}:` });
  const top = plays.keys.map((k) => ({ kind: k.name.split(":")[2], n: k.metadata?.n || 0, title: k.metadata?.title || k.name.split(":")[3] }))
    .sort((a, b) => b.n - a.n).slice(0, 15);
  const chars = (u.chars_briefings || 0) + (u.chars_stories_ahead || 0) + demandChars;
  const free = 1000000;
  const over = Math.max(0, chars - free);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString("en-GB");
  const tile = (label, value, note = "") => `<div class="t"><div class="l">${label}</div><div class="v">${value}</div>${note ? `<div class="n">${note}</div>` : ""}</div>`;
  const days = Object.entries(updater.days || {}).slice(-14).reverse()
    .map(([d, x]) => `<tr><td>${d.slice(5)}</td><td>${fmt(x.runs)}</td><td>${fmt(x.stories_added)}</td><td>${fmt(x.ai_requests)}</td><td>${fmt((x.chars_briefings || 0) + (x.chars_stories_ahead || 0))}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout numbers</title>
<style>:root{--bg:#f6f4f1;--card:#fff;--text:#1c1b19;--dim:#8a857e;--accent:#e4572e}@media(prefers-color-scheme:dark){:root{--bg:#141312;--card:#22201e;--text:#eee;--dim:#8f8a83}}
body{font:15px -apple-system,system-ui,sans-serif;margin:0 auto;max-width:720px;padding:20px 16px 40px;background:var(--bg);color:var(--text)}h1{font-size:28px;margin:0 0 2px}h2{font-size:17px;margin:26px 0 8px}.sub{color:var(--dim);margin-bottom:16px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.t{background:var(--card);border-radius:16px;padding:14px}.l{color:var(--dim);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.v{font-size:26px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}.n{color:var(--dim);font-size:12px;margin-top:2px}
.bar{height:8px;border-radius:4px;background:rgba(128,128,128,.2);overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:16px;overflow:hidden}td,th{padding:9px 12px;text-align:left;border-bottom:1px solid rgba(128,128,128,.15);font-variant-numeric:tabular-nums}th{color:var(--dim);font-size:12px}ol{background:var(--card);border-radius:16px;padding:12px 12px 12px 36px;margin:0}li{padding:5px 0}li span{color:var(--dim)}</style>
<h1>Scout numbers</h1><div class="sub">${month} · updated ${esc((updater.updated || "").slice(0, 16).replace("T", " "))} UTC</div>
<h2>Voice (Google Text-to-Speech)</h2>
<div class="t"><div class="l">Characters this month</div><div class="v">${fmt(chars)} <span style="font-size:15px;color:var(--dim)">of ${fmt(free)} free</span></div>
<div class="bar"><i style="width:${Math.min(100, chars / free * 100).toFixed(1)}%"></i></div><div class="n">${over ? `About £${(over / 1e6 * 22.55).toFixed(2)} over the free allowance` : "Inside the free allowance"}</div></div>
<div class="g" style="margin-top:10px">${tile("Briefings", fmt(u.chars_briefings), `${fmt(u.briefings_recorded)} recordings`)}${tile("Top stories ahead", fmt(u.chars_stories_ahead), `${fmt(u.stories_recorded_ahead)} stories`)}${tile("Played on demand", fmt(demandChars), `${fmt(demandStories)} stories`)}</div>
<h2>Listening</h2><div class="g">${tile("Briefings played", fmt(briefingPlays))}${tile("Stories played", fmt(storyPlays))}</div>
<h2>Most played this month</h2>${top.length ? `<ol>${top.map((t) => `<li>${esc(t.title)} <span>· ${t.kind} · ${t.n}</span></li>`).join("")}</ol>` : `<div class="t">Nothing played yet.</div>`}
<h2>News</h2><div class="g">${tile("Updates", fmt(u.runs))}${tile("New stories", fmt(u.stories_added))}${tile("Merged", fmt(u.stories_merged))}${tile("Skipped", fmt(u.stories_skipped))}${tile("AI requests", fmt(u.ai_requests))}</div>
<h2>Last 14 days</h2><table><tr><th>Day</th><th>Updates</th><th>New stories</th><th>AI requests</th><th>Characters</th></tr>${days || "<tr><td colspan=5>No days yet.</td></tr>"}</table>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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

// Paris: metro and RER disruptions from PRIM's line reports (Navitia): active ones on the line itself.
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
      // Only what's on the line itself: PRIM also lists every station's lift and escalator outages.
      const onLine = (report.line?.links || []).filter((l) => l.type === "disruption").map((l) => l.id);
      for (const did of onLine) {
        const d = disruptions.get(did);
        if (!d || (d.status && d.status !== "active")) continue;
        const level = parisLevel(d);
        if (!level) continue;
        const title = (d.messages || []).find((m) => (m.channel?.types || []).includes("title"))?.text;
        const text = title || (d.messages || [])[0]?.text;
        const works = /travaux/i.test(d.cause || "") || (d.tags || []).some((t) => /travaux/i.test(t));
        const status = level === 2 ? (works ? "Closed for works" : "Suspended") : (works ? "Planned works" : "Disrupted");
        // "Métro 7 : Panne de signalisation - Trafic très perturbé" → "Panne de signalisation - Trafic très perturbé"
        add(problems, id, { level, status, reason: plain(text).replace(/^(Métro|RER|Ligne)\s*\w+\s*:\s*/i, "") });
      }
    }
  }
  return summarise(PARIS_LINES, problems);
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


// MARK: - App Store pages (privacy policy, terms, support), linked from the app and its listing

const PAGES = {
  privacy: ["Privacy policy", `
<p>Scout is a news app. It has no accounts, no ads, no analytics and no tracking. This page explains the little information it uses, and why.</p>
<h2>What stays on your iPhone</h2>
<p>Your topics, regions, saved stories, reading history, stocks you follow and appearance settings are stored only on your iPhone. Deleting the app deletes them.</p>
<h2>Location (optional)</h2>
<p>If you allow it, Scout uses your location only to show the weather on Today. The app rounds it to about 1 km before asking the Scout service, which groups it into an area of about 5 km and shares one forecast per area. Your location is not stored or linked to you. Weather comes from Apple Weather (WeatherKit). Scout also uses the last location iOS already has to pick the nearest metro network (London, New York or Paris); it never asks for location for that.</p>
<h2>Stocks you follow</h2>
<p>When you follow a stock, its ticker (for example AAPL) is sent to the Scout service so that its price and summary are prepared. Only the ticker is sent, with no name or device identifier. Tickers stay on the shared list for 45 days after anyone last follows them.</p>
<h2>Service requests</h2>
<p>Like any web service, the Scout service (on Cloudflare) sees the IP address of each request. It is used only to limit how many requests one address can make in a day, kept for a day in a cache, and never stored with anything else.</p>
<h2>Purchases</h2>
<p>Scout Plus is bought through Apple. Scout never sees your payment details; Apple only tells the app whether your subscription is active.</p>
<h2>News</h2>
<p>Stories link to their original publishers. Opening one takes you to that publisher's site, which has its own privacy policy.</p>
<h2>Children</h2>
<p>Scout is not directed at children and collects no personal information from anyone.</p>
<h2>Contact</h2>
<p>Questions or requests: <a href="https://github.com/ralphgeb/ScoutAI/issues">open an issue on GitHub</a>.</p>`],
  terms: ["Terms of use", `
<p>Scout is provided under Apple's <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">Standard Licensed Application End User License Agreement</a>, together with these notes.</p>
<h2>Scout Plus</h2>
<p>Scout Plus is an auto-renewing monthly subscription. Payment is charged to your Apple account when you confirm the purchase. It renews automatically unless cancelled at least 24 hours before the end of the current period, and your account is charged for renewal within 24 hours before that. You can manage or cancel it in your iPhone's Settings, under your name, then Subscriptions.</p>
<h2>AI summaries</h2>
<p>Summaries, rumour odds and market notes are written by AI from public news and can be wrong. Nothing in Scout is financial advice. Every story links to its original source.</p>
<h2>Prices</h2>
<p>Stock prices may be delayed and are for information only.</p>`],
  support: ["Support", `
<p>Need help with Scout, or have an idea? <a href="https://github.com/ralphgeb/ScoutAI/issues">Open an issue on GitHub</a> and we'll get back to you.</p>
<h2>Common questions</h2>
<p><b>When is the briefing written?</b> Every morning at 6:00 London time. Pull Today down to refresh.</p>
<p><b>How do I cancel Scout Plus?</b> iPhone Settings, tap your name, then Subscriptions, then Scout Plus.</p>
<p><b>How do I restore my subscription on a new iPhone?</b> In Scout, open Settings, then Scout Plus, then Restore purchases.</p>
<p><b>Why is the weather for London?</b> Location is off for Scout. Turn it on in iPhone Settings, Scout, Location.</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></p>`],
};

function page(name) {
  const [title, body] = PAGES[name];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scout · ${title}</title><style>
:root{color-scheme:light dark;--ink:#131B2C;--bg:#F5F6F8;--accent:#E25555}
@media (prefers-color-scheme:dark){:root{--ink:#EEF0F4;--bg:#0B0F18}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:680px;margin:0 auto;padding:40px 20px 60px}h1{font-size:30px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 6px}
a{color:var(--accent)}.small{opacity:.6;font-size:14px}</style></head><body><main>
<p class="small">Scout: News on the go</p><h1>${title}</h1>${body}<p class="small">Last updated 31 October 2026</p></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "max-age=3600" } });
}
