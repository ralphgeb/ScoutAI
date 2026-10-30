// Rumour Radar — news collector.
// Runs at 7:30 and 17:00 London time on GitHub Actions (and whenever you tap
// refresh in the app). It:
//   1. reads every RSS feed listed in feeds.json (Tech, Finance and World)
//   2. a quick, cheap pass over the headlines only: drops junk and groups
//      articles about the same event, so each story is analysed once
//   3. opens each remaining article to find its picture and read its text
//   4. asks Claude to read each article and write a summary and key points for each
//      story in its own words, flag rumours with how likely they are to be
//      true, and list the stocks the story could move
//   5. writes the morning / evening tech briefing for the Today tab
//   6. saves everything to data/news.json and data/briefing.json
//
// To keep it fast and cheap it uses Claude Haiku (the fastest, lowest-cost
// model), reuses the cached instructions between requests, and runs several
// requests at once.
//
// You normally never need to touch this file. Settings you might change:
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const BRIEFING_MODEL = process.env.BRIEFING_MODEL || MODEL;
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 200); // stories analysed per run: 50 for each of the 4 sections (caps cost)
const MAX_TRIAGE = 1600;       // headlines checked in the quick first pass (cheap: headlines only), shared fairly between sections and regions
const TRIAGE_BATCH = 60;       // headlines per quick-pass request
const BATCH_SIZE = 6;          // articles per full-analysis request
// Batch mode (scheduled updates): requests go through Anthropic's Message Batches
// API at half price. It can take a while, so the daily update starts at 6:00.
const USE_BATCH = /^(1|true|yes)$/i.test(process.env.AI_BATCH || '');
const BATCH_WAIT_MIN = Number(process.env.BATCH_WAIT_MIN || 25); // after this, unfinished requests are sent normally
const PARALLEL = USE_BATCH ? 100 : 3; // AI requests running at the same time
const MAX_ARTICLE_AGE_H = 30;  // ignore articles older than this
const FASHION_AGE_H = 72;      // fashion sites publish less often, so look further back
const SECTION_MIN = 130;       // each section's fair share of MAX_STORIES
const KEEP_DAYS = 3;           // drop stories first published more than this many days ago (72 hours)
const MAX_STORIES = 520;       // stories kept in the app, shared equally between sections
const MAX_SEEN = 8000;         // how many article links to remember
const ARTICLE_CHARS = 6000;    // how much of each article the AI reads
const UPGRADE_MAX = 20;        // older stories per run that get key points added
// Share of each run's full analyses per section, so no section crowds out the others.
const SECTION_SHARE = { Tech: 0.25, Finance: 0.25, World: 0.25, Fashion: 0.25 };
// Sources that never appear in the app.
const BLOCKED = /cnbc/i;
const FASHION_OUTLETS = /WWD|Business of Fashion|Vogue|Harper's Bazaar|Fashionista|Highsnobiety|Hypebeast|Telegraph Fashion|Guardian Fashion/i;

import { parseFeed, findMetaImage, findPublished, stripHtml } from './feed-parser.mjs';
import { updateStocks, validSymbol } from './stocks.mjs';
import { publishFile, publishStocks, readPublishedStocks } from './publish.mjs';
import { vapidKeys, ensurePublicKey, saveFromApp, sendMorning } from './push.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const SEEN_FILE = path.join(DATA_DIR, 'seen.json');
const BRIEFING_FILE = path.join(DATA_DIR, 'briefing.json');
const FEEDS_FILE = path.join(ROOT, 'feeds.json');
const STOCKS_FILE = path.join(DATA_DIR, 'stocks.json');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
// The Scout iPhone app's shared list of followed stocks (stocks-worker on Cloudflare).
const STOCKS_REQUESTS_URL = process.env.STOCKS_REQUESTS_URL || 'https://scout-stocks.ralph-gebara.workers.dev';

export const TOPICS = [
  'AI', 'Apple', 'Google', 'Microsoft', 'Amazon', 'Meta', 'Nvidia', 'Tesla & EVs',
  'Chips', 'Phones & Gadgets', 'Computers', 'Gaming', 'Software & Apps', 'Cybersecurity',
  'Streaming & Media', 'Social media', 'Startups & VC', 'Crypto', 'Markets & Economy',
  'Banks & Finance', 'Deals & Mergers', 'Policy & Regulation', 'Energy', 'Cars', 'Space',
  'Science', 'Health & Biotech', 'Retail', 'Telecoms', 'UK business',
  'World politics', 'Conflict & security', 'Elections', 'Trade & tariffs', 'Central banks',
  'Commodities', 'Climate', 'Fashion & Luxury', 'Beauty', 'Designers & Shows', 'Other'
];

// Where a story mainly happens, so the app can follow the UK, the US, Europe or Asia.
// Global = worldwide, or another part of the world.
export const REGIONS = ['UK', 'US', 'Europe', 'Asia', 'Global'];
export const normRegion = (r) => REGIONS.find((x) => x.toLowerCase() === String(r || '').toLowerCase()) || 'Global';

// Sections in the app's News tab. Older data used finer sections.
export const normSection = (s) => (/^(markets|finance)$/i.test(s || '') ? 'Finance' : /^world$/i.test(s || '') ? 'World' : /^fashion$/i.test(s || '') ? 'Fashion' : 'Tech');
const sourceEntry = (a) => ({ name: a.source, title: a.title, link: a.link, published: a.published, image: a.image || '' });
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
async function runParallel(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

const log = (...a) => console.log('[rumour-radar]', ...a);

/** Tickers the last three days' stories name, most-mentioned first. */
function mentionedStocks(stories) {
  const since = Date.now() - 72 * 3600e3;
  const count = new Map();
  for (const s of stories || []) {
    if (Date.parse(s.first_published || s.first_seen || '') < since) continue;
    for (const k of s.stocks || []) {
      const t = String(k.ticker || '').toUpperCase();
      if (validSymbol(t)) count.set(t, (count.get(t) || 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/** Stocks followed in the Scout app, most recently asked for first. Empty if the list can't be reached. */
async function sharedStocks() {
  try {
    const r = await fetch(`${STOCKS_REQUESTS_URL}/list`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.symbols || []).map((x) => String(x.symbol || '').toUpperCase()).filter(validSymbol);
  } catch {
    return [];
  }
}

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

export function cleanLink(link) {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|cmpid$|src$|guccounter|ocid$)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return link; }
}
const idFor = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const trim = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const trimKeepParas = (s, n) => String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);

// ---------- 1. Collect ----------
async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'RumourRadar/1.0 (personal RSS reader)', Accept: 'application/rss+xml, application/xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseFeed(await res.text()).map((it) => {
      let source = feed.name;
      let title = trim(it.title, 300);
      // Google News titles look like "Headline - Publisher"
      if (/news\.google\.com/.test(feed.url)) {
        const m = title.match(/^(.*) - ([^-]{2,60})$/);
        if (m) { title = m[1].trim(); source = m[2].trim(); }
      }
      return {
        title,
        link: cleanLink(it.link || ''),
        source,
        section: normSection(feed.section),
        region: normRegion(feed.region),
        published: it.isoDate || new Date().toISOString(),
        snippet: trim(it.contentSnippet, 600),
        image: it.image || ''
      };
    }).filter((a) => a.title && a.link);
  } finally { clearTimeout(t); }
}

export async function collect(feeds, seen) {
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { log(`${feeds[i].name}: ${r.value.length} items`); all.push(...r.value); }
    else log(`${feeds[i].name}: failed (${r.reason?.message || r.reason})`);
  });
  const cutoff = Date.now() - MAX_ARTICLE_AGE_H * 3600e3;
  const fashionCutoff = Date.now() - FASHION_AGE_H * 3600e3;
  const seenSet = new Set(seen);
  const unique = new Map();
  for (const a of all) {
    if (BLOCKED.test(a.source) || BLOCKED.test(a.link)) continue;
    if (seenSet.has(a.link) || unique.has(a.link)) continue;
    if (new Date(a.published).getTime() < (a.section === 'Fashion' ? fashionCutoff : cutoff)) continue;
    unique.set(a.link, a);
  }
  return fairOrder([...unique.values()].sort((a, b) => b.published.localeCompare(a.published)));
}

/** Newest first, but taking each section-and-region in turn, so the triage cap can't be filled
 *  by the busiest feeds (more UK and US outlets than Asian ones, say). */
export function fairOrder(articles) {
  const groups = new Map();
  for (const a of articles) {
    const k = `${a.section}|${a.region || 'Global'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const queues = [...groups.values()];
  const out = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
  return out;
}

// Articles whose page says they were published long before the feed claims.
const STALE_DAYS = 3;
function isStale(a) {
  if (!a.pagePublished) return false;
  const page = Date.parse(a.pagePublished);
  const limit = (a.section === 'Fashion' ? FASHION_AGE_H / 24 + 1 : STALE_DAYS) * 864e5;
  return Date.now() - page > limit;
}

// ---------- 2. Read each article (text for the AI + preview picture) ----------
export function extractText(html) {
  let h = html.replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|figcaption|button)\b[\s\S]*?<\/\1>/gi, ' ');
  const article = h.match(/<article\b[\s\S]*<\/article>/i);
  if (article) h = article[0];
  const paras = [...h.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 50 && !/(cookie|subscribe|newsletter|sign up|advertis|all rights reserved|click here|follow us)/i.test(t));
  return [...new Set(paras)].join('\n').slice(0, ARTICLE_CHARS);
}

// Many sites refuse anything that doesn't look like a normal browser.
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9'
};

// ---------- Google News links → the real article ----------
// Stories found through Google News come with a news.google.com link that
// hides the publisher's address, so we couldn't read the article or its
// picture. This asks Google News for the real address (the same request its
// own web page makes). If Google ever changes this, we simply keep the old link.
const gnCache = new Map();
let gnFailures = 0;
export async function realLink(url) {
  if (!/news\.google\.com\/(rss\/)?articles\//.test(url || '')) return url;
  if (gnCache.has(url)) return gnCache.get(url);
  if (gnFailures >= 6) return url; // Google is refusing for now: stop trying this run
  const id = url.split('/articles/')[1].split(/[?#]/)[0];
  let out = url;
  try {
    // older links have the address inside them
    const raw = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    const direct = raw.match(/https?:\/\/[\x21-\x7e]+/);
    if (direct && !raw.includes('AU_yqL')) out = direct[0];
    else {
      const page = await fetch(`https://news.google.com/rss/articles/${id}`, { headers: BROWSER, signal: AbortSignal.timeout(10000) }).then((r) => r.text());
      const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
      const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
      if (!sg || !ts) throw new Error('no signature');
      const req = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]), null, 'generic']]];
      const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
        method: 'POST',
        headers: { ...BROWSER, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'f.req=' + encodeURIComponent(JSON.stringify(req)),
        signal: AbortSignal.timeout(10000)
      }).then((r) => r.text());
      const part = JSON.parse(res.split('\n\n')[1]);
      const found = JSON.parse(part[0][2])[1];
      if (/^https?:\/\//.test(found)) out = found; else throw new Error('no address');
    }
    gnFailures = 0;
  } catch { gnFailures++; }
  gnCache.set(url, out);
  return out;
}

async function fetchArticle(url) {
  url = await realLink(url);
  if (!/^https?:\/\//.test(url) || /news\.google\.com/.test(url)) return { text: '', image: '', url };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: BROWSER
    });
    noteStatus(url, 'browser', res.status);
    if (!res.ok || !res.body) return { text: '', image: '', url };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < 1_500_000) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return { text: extractText(html), image: findMetaImage(html, res.url || url), url, published: findPublished(html) };
  } catch { return { text: '', image: '', url }; } finally { clearTimeout(t); }
}

export async function readArticles(articles) {
  if (!articles.length) return;
  let withText = 0;
  for (let i = 0; i < articles.length; i += 8) {
    await Promise.all(articles.slice(i, i + 8).map(async (a) => {
      const { text, image, url, published } = await fetchArticle(a.link);
      if (url && url !== a.link && !/news\.google\.com/.test(url)) { a.feedLink = a.link; a.link = url; } // keep the publisher's own address
      if (published) a.pagePublished = published;
      a.text = text;
      if (!a.image && image) a.image = image;
      if (text) withText++;
    }));
  }
  log(`Read ${withText} of ${articles.length} articles in full (the rest use their feed summary).`);
}

// ---------- 3. Analyse with Claude ----------
const ANALYSIS_TOOL = {
  name: 'record_analysis',
  description: 'Record the analysis of every article in the batch.',
  input_schema: {
    type: 'object',
    properties: {
      analyses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            article_index: { type: 'integer' },
            keep: { type: 'boolean', description: 'true for real news: tech, AI, gadgets, science, companies, finance, markets, economics, significant world/political news, and luxury/high-fashion news (luxury houses and groups, major designers and creative directors, the big fashion weeks, global fashion business). false for local or regional fashion weeks, single store openings, local designers, mass-market retail, sport, celebrity gossip, recipes, horoscopes, shopping deals/coupons and "best buys" edits, podcasts/newsletters with no news, and puzzles.' },
            same_story_as: { type: ['string', 'null'], description: 'If this article covers the SAME specific claim/event as an existing story, that story id (e.g. "a1b2c3d4e5"), or "article:N" for an earlier article in this batch. Otherwise null.' },
            status: { type: 'string', enum: ['rumour', 'confirmed', 'denied', 'news'], description: 'rumour = unconfirmed claim (leaks, "reportedly", "sources say", analyst predictions of company plans, "in talks"), including unconfirmed political or world developments that could move markets (e.g. possible tariffs, sanctions, rate decisions, ceasefires, government interventions). confirmed = an official announcement that confirms a previously rumoured claim. denied = officially denied. news = ordinary confirmed news.' },
            claim: { type: 'string', description: 'One short, neutral sentence in your own words stating the core news or claim. Max 140 chars.' },
            summary: { type: 'string', description: 'A proper summary in your own words, based on the full article text: 4-6 sentences (about 80-130 words) covering what happened, the most important details and numbers, who is involved, and why it matters.' },
            key_points: { type: 'array', items: { type: 'string' }, description: '4-6 bullet points with the key facts, figures, background and what happens next, in your own words. Each one a full sentence. Never invent facts.' },
            likelihood: { type: ['integer', 'null'], description: 'For rumours: estimated % chance the claim turns out true (5-95). confirmed=100, denied=5, news=null.' },
            likelihood_reason: { type: 'string', description: 'One or two sentences on why you gave that likelihood. Empty for news.' },
            signals: { type: 'array', items: { type: 'string' }, description: 'Short credibility signals for rumours, e.g. "Reliable source: Bloomberg", "Single anonymous source", "Company declined to comment". Empty for news.' },
            topics: { type: 'array', items: { type: 'string', enum: TOPICS } },
            region: { type: 'string', enum: REGIONS, description: 'Where the story mainly happens or matters most: UK, US, Europe (EU and the rest of Europe, not the UK), Asia (including India, Australia and the Pacific), or Global (worldwide, several regions, or the Middle East, Africa and Latin America).' },
            overall_impact: { type: 'string', enum: ['none', 'low', 'medium', 'high'], description: 'Likely market impact (if a rumour: if it turns out true).' },
            importance: { type: 'integer', description: 'How important this story is for a general reader of its section, 1-10: 9-10 = major news everyone is talking about (big launches, major deals, elections, wars, central bank moves); 6-8 = notable; 3-5 = routine; 1-2 = minor (reviews, how-tos, small updates). Be strict.' },
            market_take: { type: 'string', description: 'One short sentence on how this could affect investors or the stocks below. Empty string if there is no market angle.' },
            stocks: {
              type: 'array',
              description: 'Up to 5 publicly traded companies most likely to be affected by this news (or by the rumour if true): the company itself, rivals, suppliers or partners. For world, political or economic news you may instead list the most affected index, currency or commodity using Yahoo Finance symbols (e.g. ^FTSE, ^GSPC, GBPUSD=X, CL=F for oil, GC=F for gold). Use real primary listing tickers (e.g. AAPL, 005930.KS, BARC.L). Empty if none.',
              items: {
                type: 'object',
                properties: {
                  ticker: { type: 'string' },
                  name: { type: 'string' },
                  direction: { type: 'string', enum: ['up', 'down', 'mixed'] },
                  impact: { type: 'string', enum: ['low', 'medium', 'high'] },
                  reason: { type: 'string', description: 'One short sentence.' }
                },
                required: ['ticker', 'name', 'direction', 'impact', 'reason']
              }
            }
          },
          required: ['article_index', 'keep', 'same_story_as', 'status', 'claim', 'summary', 'key_points', 'likelihood', 'likelihood_reason', 'signals', 'topics', 'region', 'overall_impact', 'importance', 'market_take', 'stocks']
        }
      }
    },
    required: ['analyses']
  }
};

const SYSTEM = `You are the analysis engine of a news app with four sections: Tech (tech, AI, gadgets, companies, VC), Finance (markets, companies, economy), World (major world and political news) and Fashion (luxury and high fashion: luxury houses, major designers, the big fashion weeks and the business of luxury). For every article you read the text given and write a neutral summary and key points in your own words, decide whether it is confirmed news or an unconfirmed RUMOUR, estimate how likely rumours are to be true, and list the stocks the story could move.

Writing: clear, neutral, British English, no hype. Everything must be in your own words; never copy sentences from the articles and never invent facts, figures or quotes.

For confirmed news: status "news", likelihood null, likelihood_reason "" and signals [].

Readers are in the UK, the US, Europe and Asia, so write for an international reader: say which country you mean, and give amounts in the local currency.

Estimating likelihood (be calibrated, not dramatic):
- Track record of the outlet/reporter matters most. Bloomberg, Reuters, FT, WSJ, The Information and reporters like Mark Gurman are right most of the time (often 70-90%). Supply-chain analysts (e.g. Ming-Chi Kuo) are decent on hardware (55-75%). Unknown leakers, social posts and tabloids are low (10-40%).
- More independent outlets reporting it raises likelihood; outlets merely citing one original report do not count as independent.
- Hedged language ("could", "might consider", "early talks") lowers likelihood; specific details (dates, prices, part numbers) raise it.
- Official denial: low. Official confirmation: status "confirmed", 100.
- Long-range predictions (years out) are less certain.

Fashion news: cover the designers, brands, collections and business angle; luxury groups and retailers (e.g. LVMH MC.PA, Kering KER.PA, Hermès RMS.PA, Richemont CFR.SW, Prada 1913.HK, Burberry BRBY.L, Inditex ITX.MC, Moncler MONC.MI) are the usual stocks. Celebrity and red-carpet style stories usually move no stocks.

World and political news: say plainly what happened and, where relevant, how it could affect markets (indices, currencies, commodities, sectors). Unconfirmed reports of market-moving decisions are rumours.

Stock impact (for news AND rumours): think about the company itself, competitors, suppliers and partners. Only list companies that are actually publicly traded, with correct tickers; private companies (e.g. OpenAI, Anthropic, SpaceX) have no ticker, so list affected public companies instead. If unsure of a ticker, leave the company out. Be modest: most stories are low or medium impact, and product reviews or how-to articles usually have none.

Analyse every article in the batch and call record_analysis exactly once.`;

async function callClaude(body, apiKey) {
  if (USE_BATCH) return batchCall(body, apiKey);
  return callDirect(body, apiKey);
}

// ---------- Batch mode ----------
// Requests made at the same moment are collected and sent as one batch; each
// caller gets its own answer back. Anything not finished within BATCH_WAIT_MIN
// (or that fails) is sent again the normal way, so an update is never stuck.
const batchQueue = [];
let batchTimer = null;
const API = 'https://api.anthropic.com/v1/messages';
const apiHeaders = (apiKey) => ({ 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
let batchStats = { sent: 0, done: 0, fallback: 0 };

function batchCall(body, apiKey) {
  return new Promise((resolve, reject) => {
    batchQueue.push({ body: withCache(body), resolve, reject, apiKey });
    if (!batchTimer) batchTimer = setTimeout(flushBatch, 1500);
  });
}

async function flushBatch() {
  batchTimer = null;
  const items = batchQueue.splice(0);
  if (!items.length) return;
  const apiKey = items[0].apiKey;
  const direct = (list) => Promise.all(list.map((it) => { batchStats.fallback++; return callDirect(it.body, apiKey).then(it.resolve, it.reject); }));
  let batch;
  try {
    const res = await fetch(`${API}/batches`, { method: 'POST', headers: apiHeaders(apiKey), body: JSON.stringify({ requests: items.map((it, i) => ({ custom_id: `r${i}`, params: it.body })) }) });
    batch = await res.json();
    if (!res.ok) {
      const msg = batch?.error?.message || res.statusText;
      if (res.status === 401) { const e = Object.assign(new Error('Your Anthropic API key was rejected. Check the ANTHROPIC_API_KEY secret on GitHub.'), { fatal: true }); items.forEach((it) => it.reject(e)); return; }
      if (/credit/i.test(msg)) { const e = Object.assign(new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com.'), { fatal: true }); items.forEach((it) => it.reject(e)); return; }
      throw new Error(`batch ${res.status}: ${msg}`);
    }
  } catch (e) { log(`Batch not accepted (${e.message}); sending normally.`); return direct(items); }
  batchStats.sent += items.length;
  log(`AI batch of ${items.length} request(s) sent (half price); waiting for it…`);
  const t0 = Date.now();
  let status = batch;
  while (status.processing_status !== 'ended' && Date.now() - t0 < BATCH_WAIT_MIN * 60e3) {
    await new Promise((r) => setTimeout(r, 15000));
    try { status = await (await fetch(`${API}/batches/${batch.id}`, { headers: apiHeaders(apiKey) })).json(); } catch { /* keep waiting */ }
  }
  const results = new Map();
  if (status.processing_status !== 'ended') {
    log(`Batch still running after ${BATCH_WAIT_MIN} min; cancelling it and sending the rest normally.`);
    fetch(`${API}/batches/${batch.id}/cancel`, { method: 'POST', headers: apiHeaders(apiKey) }).catch(() => {});
  } else {
    try {
      const txt = await (await fetch(status.results_url, { headers: apiHeaders(apiKey) })).text();
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); results.set(r.custom_id, r.result); } catch { /* skip */ }
      }
    } catch (e) { log(`Batch results not read: ${e.message}`); }
    log(`AI batch finished in ${Math.round((Date.now() - t0) / 60e3)} min.`);
  }
  const retry = [];
  items.forEach((it, i) => {
    const r = results.get(`r${i}`);
    const tool = r?.type === 'succeeded' ? (r.message?.content || []).find((c) => c.type === 'tool_use') : null;
    if (tool?.input) { batchStats.done++; it.resolve(tool.input); } else retry.push(it);
  });
  if (retry.length) await direct(retry);
}

const withCache = (body) => (typeof body.system === 'string' ? { ...body, system: [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }] } : body);

async function callDirect(body, apiKey) {
  // Cache the long, repeated instructions so later requests in the run are cheaper and faster.
  if (typeof body.system === 'string') body = { ...body, system: [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }] };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) {
        const msg = json?.error?.message || res.statusText;
        if (res.status === 401) throw Object.assign(new Error('Your Anthropic API key was rejected. Check the ANTHROPIC_API_KEY secret on GitHub.'), { fatal: true });
        if (res.status === 400 && /credit/i.test(msg)) throw Object.assign(new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com.'), { fatal: true });
        throw new Error(`API ${res.status}: ${msg}`);
      }
      const tool = (json.content || []).find((c) => c.type === 'tool_use');
      if (!tool?.input) throw new Error('AI returned no result');
      return tool.input;
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      log(`AI request failed (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  throw lastErr;
}

export async function analyseBatch(batch, existing, apiKey) {
  const existingList = existing.length
    ? existing.map((s) => `${s.id} | ${s.status} | ${s.sources.length} outlet(s) | ${s.claim}`).join('\n')
    : '(none yet)';
  const articles = batch.map((a, i) =>
    `[article:${i}] Source: ${a.source}\nPublished: ${a.published}\nHeadline: ${a.title}\n` +
    (a.text ? `Article text:\n${a.text}` : `Feed summary only: ${a.snippet || '(none)'}`)
  ).join('\n\n---\n\n');

  const input = await callClaude({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: 'record_analysis' },
    messages: [{
      role: 'user',
      content: `Today is ${new Date().toUTCString().slice(0, 16)}. If an article is clearly an old story being recirculated (the events happened weeks or months ago), set keep to false.\n\nExisting stories from the last few days (id | status | outlets | claim):\n${existingList}\n\nNew articles to analyse:\n\n${articles}`
    }]
  }, apiKey);
  if (!Array.isArray(input.analyses)) throw new Error('AI returned no analysis');
  return input.analyses;
}

// ---------- 3b. Quick first pass over headlines ----------
const TRIAGE_TOOL = {
  name: 'record_triage',
  description: 'Record a decision for every headline.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer', description: 'Headline number.' },
            keep: { type: 'boolean', description: 'false for sport, celebrity gossip, recipes, horoscopes, shopping deals and "best buys" lists, puzzles, podcasts/newsletters with no news, and trivial items. true for real tech, business, finance, economic, political and world news. Fashion is a LUXURY and high-fashion section: keep news about luxury houses and groups (LVMH, Kering, Hermès, Chanel, Prada, Richemont…), major designers and creative directors, the big four fashion weeks (Paris, Milan, London, New York) and couture, and major global fashion business. Drop local or regional fashion weeks, store openings in individual cities, local designers, regional or mass-market retail news, beauty contests, shopping edits, horoscopes and celebrity gossip.' },
            same_as: { type: ['string', 'null'], description: 'If it reports the SAME specific event as an existing story, that story id; or "a:N" for an earlier headline N in this list about the same event. Otherwise null. Be strict: same event, not just same topic.' }
          },
          required: ['i', 'keep', 'same_as']
        }
      }
    },
    required: ['items']
  }
};

const TRIAGE_SYSTEM = 'You sort incoming news headlines for a news app (sections: Tech, Finance, World, Fashion). For every headline decide whether to keep it and whether it duplicates an existing story or an earlier headline in the list. Call record_triage once with one item per headline.';

async function triageBatch(batch, recent, apiKey) {
  const existing = recent.map((s) => `${s.id} | ${s.headline || s.claim}`).join('\n') || '(none)';
  const lines = batch.map((a, i) => `[${i}] ${a.section} | ${a.source} | ${a.title}`).join('\n');
  const input = await callClaude({
    model: MODEL,
    max_tokens: 6000,
    system: TRIAGE_SYSTEM,
    tools: [TRIAGE_TOOL],
    tool_choice: { type: 'tool', name: 'record_triage' },
    messages: [{ role: 'user', content: `Existing stories (id | headline):\n${existing}\n\nNew headlines:\n${lines}` }]
  }, apiKey);
  return Array.isArray(input.items) ? input.items : [];
}

// Returns the groups of articles that need a full analysis. Duplicates of
// stories we already have are added to them as extra sources right away.
export async function triageAll(pool, stories, apiKey, done, now = new Date().toISOString()) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const recent = [...stories].sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || '')).slice(0, 150);
  const groups = [];
  const stats = { dropped: 0, attached: 0 };
  const batches = chunk(pool, TRIAGE_BATCH);
  const results = new Array(batches.length);
  await runParallel(batches, PARALLEL, async (batch, b) => {
    try { results[b] = await triageBatch(batch, recent, apiKey); } catch (e) {
      if (e.fatal) throw e;
      log(`Quick pass failed for one batch, analysing it in full instead: ${e.message}`);
      results[b] = batch.map((_, i) => ({ i, keep: true, same_as: null }));
    }
  });
  batches.forEach((batch, b) => {
    const decided = new Map((results[b] || []).map((r) => [r.i, r]));
    const local = new Map();
    const later = [];
    batch.forEach((a, i) => {
      const r = decided.get(i) || { keep: true, same_as: null };
      if (!r.keep) { done.push(a.link); stats.dropped++; return; }
      const ref = r.same_as;
      if (typeof ref === 'string' && /^a:\d+$/.test(ref)) { later.push([a, i, Number(ref.slice(2))]); return; }
      if (ref && byId.has(ref)) {
        const s = byId.get(ref);
        if (s.status === 'rumour') {
          // could confirm or deny the rumour, so it gets a full look
          const g = { art: a, extras: [], target: s }; groups.push(g); local.set(i, g); return;
        }
        if (!s.sources.some((x) => x.link === a.link)) s.sources.push(sourceEntry(a));
        if (!s.image && a.image) s.image = a.image;
        s.last_updated = now;
        done.push(a.link); stats.attached++;
        return;
      }
      const g = { art: a, extras: [] }; groups.push(g); local.set(i, g);
    });
    for (const [a, i, n] of later) {
      const g = local.get(n);
      if (g) { g.extras.push(a); stats.attached++; } else { const ng = { art: a, extras: [] }; groups.push(ng); local.set(i, ng); }
    }
  });
  log(`Quick pass: ${pool.length} headlines → ${groups.length} stories to analyse, ${stats.attached} duplicates grouped, ${stats.dropped} dropped.`);
  return groups;
}

// ---------- 4. Merge into stories ----------
const IMPACT_RANK = { none: 0, low: 1, medium: 2, high: 3 };

export function sanitise(an) {
  const topics = (an.topics || []).filter((t) => TOPICS.includes(t));
  let likelihood = an.likelihood;
  if (an.status === 'confirmed') likelihood = 100;
  else if (an.status === 'news') likelihood = null;
  else if (typeof likelihood === 'number') likelihood = Math.max(1, Math.min(99, Math.round(likelihood)));
  else likelihood = an.status === 'denied' ? 5 : 50;
  const stocks = (an.stocks || [])
    .filter((s) => s && /^[A-Z0-9.\-^=]{1,15}$/i.test(String(s.ticker || '').trim()))
    .slice(0, 5)
    .map((s) => ({
      ticker: String(s.ticker).trim().toUpperCase(),
      name: trim(s.name, 60),
      direction: ['up', 'down', 'mixed'].includes(s.direction) ? s.direction : 'mixed',
      impact: ['low', 'medium', 'high'].includes(s.impact) ? s.impact : 'low',
      reason: trim(s.reason, 200)
    }));
  return {
    status: ['rumour', 'confirmed', 'denied', 'news'].includes(an.status) ? an.status : 'news',
    claim: trim(an.claim, 200),
    summary: trim(an.summary, 1200),
    key_points: (an.key_points || []).map((p) => trim(p, 300)).filter(Boolean).slice(0, 6),
    likelihood,
    likelihood_reason: trim(an.likelihood_reason, 400),
    signals: (an.signals || []).map((s) => trim(s, 80)).filter(Boolean).slice(0, 6),
    topics: topics.length ? topics : ['Other'],
    region: normRegion(an.region),
    overall_impact: IMPACT_RANK[an.overall_impact] !== undefined ? an.overall_impact : 'low',
    importance: Math.max(1, Math.min(10, Math.round(Number(an.importance) || 4))),
    market_take: trim(an.market_take, 240),
    stocks
  };
}

export function mergeBatch(stories, batch, analyses, now = new Date().toISOString()) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const batchStory = new Map(); // article index -> story id
  // Articles that point at another article in this batch are handled last,
  // so the story they point at already exists whatever order they arrived in.
  const refsBatch = (a) => /^article:\d+$/.test(a.same_story_as || '');
  const sorted = [...analyses].sort((a, b) => (refsBatch(a) - refsBatch(b)) || (a.article_index - b.article_index));
  let added = 0, merged = 0, dropped = 0;

  for (const an of sorted) {
    const art = batch[an.article_index];
    if (!art || batchStory.has(an.article_index)) continue;
    if (!an.keep) { dropped++; continue; }
    const clean = sanitise(an);
    const sourceEntry = { name: art.source, title: art.title, link: art.link, published: art.published, image: art.image || '' };

    let target = null;
    const ref = an.same_story_as;
    if (typeof ref === 'string') {
      const m = ref.match(/^article:(\d+)$/);
      if (m && batchStory.has(Number(m[1]))) target = byId.get(batchStory.get(Number(m[1])));
      else if (byId.has(ref)) target = byId.get(ref);
    }

    if (target) {
      if (!target.sources.some((s) => s.link === art.link)) target.sources.push(sourceEntry);
      // Status upgrades: a rumour can become confirmed or denied.
      if (clean.status === 'confirmed' || clean.status === 'denied') {
        target.status = clean.status;
        target.likelihood = clean.likelihood;
        target.likelihood_reason = clean.likelihood_reason;
        target.resolved_at = now;
        // a confirmation is new information, so its summary replaces the old one
        if (clean.summary) { target.summary = clean.summary; if (clean.key_points.length) target.key_points = clean.key_points; }
      } else if (target.status === 'rumour' && clean.status === 'rumour') {
        target.likelihood = clean.likelihood; // newest estimate, made knowing there are more outlets
        target.likelihood_reason = clean.likelihood_reason;
      }
      // keep the richest key points
      if (clean.key_points.join(' ').length > (target.key_points || []).join(' ').length * 1.3) target.key_points = clean.key_points;
      target.signals = [...new Set([...clean.signals, ...(target.signals || [])])].slice(0, 8);
      target.topics = [...new Set([...target.topics, ...clean.topics])].filter((t) => t !== 'Other' || target.topics.length === 1);
      if (!target.region || target.region === 'Global') target.region = clean.region;
      if (IMPACT_RANK[clean.overall_impact] > IMPACT_RANK[target.overall_impact]) target.overall_impact = clean.overall_impact;
      if ((clean.importance || 0) > (target.importance || 0)) target.importance = clean.importance;
      if (!target.image && art.image) target.image = art.image;
      if (!target.market_take && clean.market_take) target.market_take = clean.market_take;
      const tickers = new Set(target.stocks.map((s) => s.ticker));
      for (const s of clean.stocks) if (!tickers.has(s.ticker) && target.stocks.length < 6) target.stocks.push(s);
      target.last_updated = now;
      batchStory.set(an.article_index, target.id);
      merged++;
    } else {
      const story = {
        id: idFor(art.link),
        headline: art.title,
        section: normSection(art.section),
        image: art.image || '',
        image_checked: true,
        ...clean,
        sources: [sourceEntry],
        first_seen: now,
        first_published: art.published,
        last_updated: now
      };
      if (byId.has(story.id)) continue;
      byId.set(story.id, story);
      stories.push(story);
      batchStory.set(an.article_index, story.id);
      added++;
    }
  }
  return { added, merged, dropped, handled: new Set(sorted.map((a) => a.article_index)), storyOf: batchStory };
}

// ---------- 5. Daily briefing ----------
const BRIEFING_TOOL = {
  name: 'record_briefing',
  description: 'Record the briefing.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A punchy front-page headline for this briefing, max 70 chars, naming the biggest story.' },
      notification: { type: 'string', description: 'A catchy one-line teaser of the biggest story for a phone notification, max 110 characters, in your own words, no emoji, no clickbait: make the reader want to open the app.' },
      intro: { type: 'string', description: 'A proper overview of the main events of this period, like the front page of a newspaper: 2-3 short paragraphs separated by a blank line (about 150-220 words), covering the biggest stories, what they mean and how they connect. Your own words; never invent facts.' },
      top_stories: {
        type: 'array', description: 'The 5-7 most important stories, most important first.',
        items: { type: 'object', properties: {
          story_id: { type: 'string' },
          title: { type: 'string', description: 'Short headline in your own words, max 80 chars.' },
          summary: { type: 'string', description: '2-3 sentences: what happened and why it matters.' }
        }, required: ['story_id', 'title', 'summary'] }
      },
      rumour_watch: {
        type: 'array', description: 'Up to 4 of the most interesting open rumours.',
        items: { type: 'object', properties: {
          story_id: { type: 'string' },
          note: { type: 'string', description: 'One sentence on the rumour and why it is or is not credible.' }
        }, required: ['story_id', 'note'] }
      },
      stocks_to_watch: {
        type: 'array', description: 'Up to 6 stocks most affected by this period’s news.',
        items: { type: 'object', properties: {
          ticker: { type: 'string' }, name: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'mixed'] },
          note: { type: 'string', description: 'One short sentence on why.' }
        }, required: ['ticker', 'name', 'direction', 'note'] }
      },
      in_brief: {
        type: 'array', description: '5-8 other notable stories, one line each.',
        items: { type: 'object', properties: {
          story_id: { type: 'string' },
          line: { type: 'string', description: 'One sentence, max 140 chars.' }
        }, required: ['story_id', 'line'] }
      }
    },
    required: ['title', 'notification', 'intro', 'top_stories', 'rumour_watch', 'stocks_to_watch', 'in_brief']
  }
};

const londonHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/London' }).format(d));

export async function makeBriefing(stories, apiKey, now = new Date()) {
  const edition = londonHour(now) < 12 ? 'Morning' : 'Evening';
  const since = new Date(now.getTime() - 16 * 3600e3).toISOString();
  const pub = (s) => s.first_published || s.first_seen || '';
  const score = (s) => (s.sources?.length || 1) * 2 + (IMPACT_RANK[s.overall_impact] || 0) * 2 + (s.status === 'rumour' ? 1 : 0) + (s.status === 'confirmed' ? 2 : 0);
  const pool = stories.filter((s) => normSection(s.section) === 'Tech')
    .filter((s) => pub(s) >= since || (s.last_updated || '') >= since)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 90);
  if (pool.length < 3) { log('Not enough recent stories for a briefing yet.'); return null; }

  const list = pool.map((s) => `${s.id} | ${s.status}${s.likelihood != null && s.status === 'rumour' ? ' ' + s.likelihood + '%' : ''} | ${s.sources.length} outlet(s) | impact ${s.overall_impact} | ${s.section} | ${s.headline || s.claim}\n   ${s.summary}${(s.stocks || []).length ? '\n   Stocks: ' + s.stocks.map((k) => `${k.ticker} ${k.direction}`).join(', ') : ''}`).join('\n');

  const input = await callClaude({
    model: BRIEFING_MODEL,
    max_tokens: 4000,
    system: `You are the editor of "Rumour Radar", a daily morning TECH briefing (tech, AI, gadgets, big tech companies, startups and VC, and tech stocks). Write the ${edition.toLowerCase()} briefing covering the last 24 hours for a busy reader. Pick what genuinely matters (big launches, deals, earnings, regulation, AI breakthroughs, market moves, credible rumours), not minor product reviews. Use only story ids from the list. Be neutral, clear, British English, in your own words. Call record_briefing once.`,
    tools: [BRIEFING_TOOL],
    tool_choice: { type: 'tool', name: 'record_briefing' },
    messages: [{ role: 'user', content: `Stories (id | status | outlets | impact | section | headline, then summary):\n${list}` }]
  }, apiKey);

  const ids = new Set(pool.map((s) => s.id));
  const okId = (x) => x && ids.has(x.story_id);
  return {
    id: idFor(now.toISOString()),
    edition,
    generated: now.toISOString(),
    covers_from: since,
    story_count: pool.length,
    title: trim(input.title, 100),
    notification: trim(input.notification, 140),
    intro: trimKeepParas(input.intro, 2000),
    top_stories: (input.top_stories || []).filter(okId).slice(0, 7).map((x) => ({ story_id: x.story_id, title: trim(x.title, 120), summary: trim(x.summary, 500) })),
    rumour_watch: (input.rumour_watch || []).filter(okId).slice(0, 4).map((x) => ({ story_id: x.story_id, note: trim(x.note, 300) })),
    stocks_to_watch: (input.stocks_to_watch || []).filter((x) => /^[A-Z0-9.\-^=]{1,15}$/i.test(x.ticker || '')).slice(0, 6).map((x) => ({
      ticker: x.ticker.toUpperCase(), name: trim(x.name, 60), direction: ['up', 'down', 'mixed'].includes(x.direction) ? x.direction : 'mixed', note: trim(x.note, 200)
    })),
    in_brief: (input.in_brief || []).filter(okId).slice(0, 8).map((x) => ({ story_id: x.story_id, line: trim(x.line, 200) }))
  };
}

function shouldMakeBriefing(briefing) {
  const mode = (process.env.MAKE_BRIEFING || 'auto').toLowerCase();
  if (mode === 'yes' || mode === 'true') return true;
  if (mode === 'no' || mode === 'false') return false;
  if (process.env.GITHUB_EVENT_NAME === 'schedule') return true;
  const last = briefing.editions?.[0];
  // On a manual refresh: make one if there is none yet, or the latest is old.
  return !last || Date.now() - new Date(last.generated).getTime() > 8 * 3600e3;
}

// ---------- Upgrade older stories ----------
// Stories saved by earlier versions have no picture, key points or write-up.
// Each run fills in a batch of the most recent ones.
export async function upgradeOld(stories, apiKey) {
  const cutoff = new Date(Date.now() - 48 * 3600e3).toISOString();
  const pub = (s) => s.first_published || s.first_seen || '';
  const needWriteUp = stories
    .filter((s) => !(s.key_points || []).length && !s.upgrade_tried && pub(s) >= cutoff)
    .sort((a, b) => pub(b).localeCompare(pub(a)))
    .slice(0, UPGRADE_MAX);
  const needImage = stories.filter((s) => !s.image && !s.image_checked && !needWriteUp.includes(s)).slice(0, 60);
  if (!needWriteUp.length && !needImage.length) return;

  // pictures only
  for (let i = 0; i < needImage.length; i += 8) {
    await Promise.all(needImage.slice(i, i + 8).map(async (s) => {
      const { image } = await fetchArticle(s.sources?.[0]?.link || '');
      if (image) s.image = image;
      s.image_checked = true;
    }));
  }

  // pictures + AI write-ups
  const arts = needWriteUp.map((s) => {
    const src = s.sources?.[0] || {};
    return { story: s, title: s.headline || src.title || s.claim, link: src.link || '', source: src.name || '', published: pub(s), snippet: s.summary || '' };
  });
  await readArticles(arts);
  let done = 0;
  await Promise.all(chunk(arts, BATCH_SIZE).map(async (batch) => {
    try {
      const analyses = await analyseBatch(batch, [], apiKey);
      for (const an of analyses) {
        const a = batch[an.article_index];
        if (!a) continue;
        const s = a.story;
        const c = sanitise(an);
        if (c.summary) s.summary = c.summary;
        if (c.key_points.length) s.key_points = c.key_points;
        if (!s.market_take && c.market_take) s.market_take = c.market_take;
        if (!(s.stocks || []).length && c.stocks.length) s.stocks = c.stocks;
        if (!s.image && a.image) s.image = a.image;
        done++;
      }
    } catch (e) {
      if (e.fatal) throw e;
      log(`Upgrade batch skipped: ${e.message}`);
    }
    batch.forEach((a) => { a.story.upgrade_tried = true; a.story.image_checked = true; });
  }));
  log(`Upgraded ${done} older stories with key points; checked ${needImage.length} for pictures.`);
}

// ---------- Fair mix: share each run between sections and outlets ----------
export function pickFair(groups, max) {
  if (groups.length <= max) return groups;
  const bySection = {};
  for (const g of groups) (bySection[g.art.section] ||= []).push(g);
  // within a section, take regions in turn, and within a region outlets in turn (newest first from each),
  // so every region gets its share of the stories analysed
  const turns = (list, key) => {
    const by = new Map();
    for (const g of list) { const k = key(g); if (!by.has(k)) by.set(k, []); by.get(k).push(g); }
    const queues = [...by.values()];
    const out = [];
    while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
    return out;
  };
  const roundRobin = (list) => {
    const byRegion = new Map();
    for (const g of list) { const r = g.art.region || 'Global'; if (!byRegion.has(r)) byRegion.set(r, []); byRegion.get(r).push(g); }
    const queues = [...byRegion.values()].map((l) => turns(l, (g) => g.art.source));
    const out = [];
    while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
    return out;
  };
  const ordered = Object.fromEntries(Object.entries(bySection).map(([k, v]) => [k, roundRobin(v)]));
  const picked = [];
  for (const [sec, share] of Object.entries(SECTION_SHARE)) picked.push(...(ordered[sec] || []).splice(0, Math.round(max * share)));
  // spare places (when a section has fewer new stories than its share) go to the other sections in turn
  const queues = Object.values(ordered).filter((q) => q.length);
  const rest = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) rest.push(q.shift());
  return [...picked, ...rest].slice(0, max);
}

// ---------- Pictures from other outlets covering the same story ----------
// Many sites (Bloomberg, FT, WSJ, Reuters via Google News…) don't share a
// picture. For those we look for the SAME story at other news outlets (via
// Bing News and the free GDELT news index) and use that article's picture,
// credited to the outlet. An AI check makes sure the other article is about
// the same specific event; if nothing matches, the story keeps its coloured
// box with the outlet's name rather than showing a wrong picture.
const UA = BROWSER;
const BAD_IMAGE = /logo|placeholder|default[-_.]|fallback|sprite|icon|avatar|blank|1x1|pixel|og-default|share-default|social-default/i;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function getText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: UA });
    return res.ok ? await res.text() : '';
  } catch { return ''; } finally { clearTimeout(t); }
}
const xmlText = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeXml(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : '';
};
const decodeXml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

// Bing News search (RSS): other outlets' articles with their thumbnails.
async function bingNews(query) {
  const xml = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=en-GB`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 10).map(([, it]) => {
    let link = xmlText(it, 'link');
    const real = link.match(/[?&]url=([^&]+)/i);
    if (real) { try { link = decodeURIComponent(real[1]); } catch { /* keep */ } }
    let img = xmlText(it, 'News:Image');
    return { title: xmlText(it, 'title'), outlet: xmlText(it, 'News:Source') || hostOf(link), link, image: img };
  }).filter((c) => c.title && c.link);
}

// Google News search: shows each article with the publisher's own thumbnail,
// even for sites that block us from opening the article (Reuters, FT, Bloomberg,
// WSJ, NYT…). We only use it when the result's headline matches ours.
const words = (t) => new Set(String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
export function sameHeadline(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.8 || both / new Set([...A, ...B]).size >= 0.6;
}
export function parseGoogleNewsPage(html) {
  const out = [];
  for (const [block] of html.matchAll(/<article\b[\s\S]*?<\/article>/gi)) {
    const titles = [...block.matchAll(/<a\b[^>]*>([^<]{15,300})<\/a>/gi)].map((m) => m[1].trim());
    const title = titles.sort((x, y) => y.length - x.length)[0] || '';
    const imgs = [...block.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).filter((t) => !/favicon|faviconV2|-w16-|-h16-/i.test(t));
    let src = '';
    for (const t of imgs) {
      const set = (t.match(/srcset="([^"]+)"/i) || [])[1];
      const one = set ? set.split(',').map((x) => x.trim().split(/\s+/)[0]).pop() : (t.match(/\ssrc="([^"]+)"/i) || [])[1];
      if (one && /attachments|googleusercontent|gstatic/.test(one)) { src = one; break; }
    }
    if (!title || !src) continue;
    src = src.replace(/&amp;/g, '&');
    if (src.startsWith('/')) src = 'https://news.google.com' + src;
    src = src.replace(/=-?w\d+-h\d+/, '=-w800-h450');
    out.push({ title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), image: src });
  }
  return out;
}
async function googleNewsThumb(headline) {
  if (!headline) return '';
  const html = await getText(`https://news.google.com/search?q=${encodeURIComponent(headline.slice(0, 140))}&hl=en-GB&gl=GB&ceid=GB:en`, 10000);
  picStats.gnPages = (picStats.gnPages || 0) + 1;
  picStats.gnPageBytes = html.length;
  picStats.gnArticles = (picStats.gnArticles || 0) + (html.match(/<article\b/gi) || []).length;
  const hit = parseGoogleNewsPage(html).find((c) => sameHeadline(c.title, headline));
  return hit ? hit.image : '';
}

// GDELT: a free index of world news, with each article's share picture.
let lastGdelt = 0;
async function gdelt(query) {
  const wait = lastGdelt + 5500 - Date.now();   // GDELT allows about one request every 5 seconds
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGdelt = Date.now();
  const txt = await getText(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query + ' sourcelang:english')}&mode=artlist&format=json&maxrecords=12&timespan=3d&sort=hybridrel`, 12000);
  try {
    return (JSON.parse(txt).articles || []).map((a) => ({ title: a.title || '', outlet: a.domain || hostOf(a.url), link: a.url, image: a.socialimage || '' })).filter((c) => c.title && c.link);
  } catch { return []; }
}

// Link-preview crawlers: many news sites block ordinary scripts but still give
// their picture to the bots that build link previews (Facebook, X, Slack, iMessage),
// because they want their links to look good when shared.
const PREVIEW_UAS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  'Twitterbot/1.0',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'
];
export const picStats = { own: 0, preview: 0, microlink: 0, googleNews: 0, otherOutlets: 0, missing: 0, statuses: {} };
const noteStatus = (url, how, code) => { const h = hostOf(url); if (!h) return; picStats.statuses[h] ||= {}; picStats.statuses[h][how] = code; };
async function previewImage(url) {
  for (const ua of PREVIEW_UAS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      noteStatus(url, 'preview', res.status);
      if (!res.ok || !res.body) continue;
      const reader = res.body.getReader(); const dec = new TextDecoder(); let html = '';
      while (html.length < 400_000) { const { value, done } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
      reader.cancel().catch(() => {});
      const img = findMetaImage(html, res.url || url);
      if (img && !BAD_IMAGE.test(img)) return img;
    } catch { noteStatus(url, 'preview', 'error'); }
  }
  return '';
}
// Microlink: a free link-preview service (about 50 look-ups a day without a key).
let microlinkLeft = 45;
async function microlinkImage(url) {
  if (microlinkLeft <= 0) return '';
  microlinkLeft--;
  try {
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20000) });
    noteStatus(url, 'microlink', res.status);
    if (res.status === 429) microlinkLeft = 0;
    if (!res.ok) return '';
    const img = (await res.json())?.data?.image?.url || '';
    return img && !BAD_IMAGE.test(img) ? img : '';
  } catch { return ''; }
}

// DuckDuckGo news (free) and, if you've added a BRAVE_API_KEY secret, Brave
// news search: both list each article with the publisher's own thumbnail.
async function newsSearchImages(need, apiKey) {
  let ddg = 0; let brave = 0;
  const items = need.map((s, i) => ({ id: String(i), title: s.sources?.[0]?.title || s.headline || '', link: (s.sources || []).map((x) => x.link).find((l) => l && !/news\.google\.com/.test(l)) || '' }));
  const tmp = path.join(DATA_DIR, '..', '.img-in.json');
  const out = path.join(DATA_DIR, '..', '.img-out.json');
  try {
    await fs.writeFile(tmp, JSON.stringify(items));
    await new Promise((resolve) => execFile(process.env.PYTHON || 'python3', [path.join(ROOT, 'scripts', 'news_images.py'), tmp, out], { timeout: 8 * 60e3 }, (err, so, se) => {
      if (so) process.stdout.write(so);
      if (err) log(`DuckDuckGo picture search skipped: ${(se || err.message).split('\n').filter(Boolean).slice(-1)[0]}`);
      resolve();
    }));
    const found = JSON.parse(await fs.readFile(out, 'utf8').catch(() => '{}'));
    for (const [i, img] of Object.entries(found)) { const s = need[Number(i)]; if (s && img && !BAD_IMAGE.test(img)) { s.image = img; ddg++; } }
  } catch (e) { log(`DuckDuckGo picture search failed: ${e.message}`); }
  finally { fs.rm(tmp, { force: true }).catch(() => {}); fs.rm(out, { force: true }).catch(() => {}); }
  picStats.duckduckgo = ddg;

  const key = process.env.BRAVE_API_KEY;
  if (key) {
    for (const s of need.filter((x) => !x.image).slice(0, 80)) {
      const title = s.sources?.[0]?.title || s.headline || '';
      const link = (s.sources || []).map((x) => x.link).find((l) => l && !/news\.google\.com/.test(l)) || '';
      try {
        const res = await fetch(`https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(title.slice(0, 150))}&count=10`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(10000) });
        noteStatus('https://brave.com', 'brave', res.status);
        if (!res.ok) { if (res.status === 401 || res.status === 403 || res.status === 429) break; continue; }
        const results = (await res.json()).results || [];
        const k = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase(); } catch { return ''; } };
        const hit = results.find((r) => link && k(r.url) === k(link) && (r.thumbnail?.original || r.thumbnail?.src))
          || results.find((r) => sameHeadline(r.title, title) && (r.thumbnail?.original || r.thumbnail?.src));
        const img = hit && (hit.thumbnail.original || hit.thumbnail.src);
        if (img && !BAD_IMAGE.test(img)) { s.image = img; brave++; }
      } catch { /* try the next one */ }
      await new Promise((r) => setTimeout(r, 1100)); // 1 request a second
    }
  }
  picStats.brave = brave;
  log(`Pictures from news search: DuckDuckGo ${ddg}${key ? `, Brave ${brave}` : ''}.`);
  return ddg + brave;
}

const QUERY_TOOL = {
  name: 'record_queries',
  description: 'Record a news search query for every headline.',
  input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
    i: { type: 'integer' },
    query: { type: 'string', description: '3-7 words that would find other news articles about this exact event (names, product, company, key fact). No quotes or operators.' }
  }, required: ['i', 'query'] } } }, required: ['items'] }
};
const MATCH_TOOL = {
  name: 'record_matches',
  description: 'Record, for every story, which candidate article reports the same specific event.',
  input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
    i: { type: 'integer', description: 'Story number.' },
    match: { type: 'integer', description: 'Number of the candidate that reports the SAME specific event (same announcement, product, deal, result or incident), or -1 if none does. Same company or topic is NOT enough. When unsure, -1.' }
  }, required: ['i', 'match'] } } }, required: ['items'] }
};

export async function fillMissingImages(stories, apiKey) {
  const cutoff = new Date(Date.now() - 72 * 3600e3).toISOString();
  // Pictures found by the old Wikipedia method are often off-topic: remove them.
  for (const s of stories) if (s.image_credit === 'Wikipedia') { s.image = ''; delete s.image_credit; s.pic_checked = 0; }
  // new ways of finding pictures: give every story another try
  for (const s of stories) if ((s.pic_v || 0) < 3) { s.pic_v = 3; s.pic_checked = 0; }
  let need = stories
    .filter((s) => !s.image && !(s.sources || []).some((x) => x.image) && (s.pic_checked || 0) < 3 && (s.last_updated || '') >= cutoff)
    .sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))
    .slice(0, 200);
  if (!need.length) return;
  const started = Date.now();

  // 0. the story's own articles: find the real address behind Google News links and read the picture there
  let own = 0;
  for (const part of chunk(need, 6)) {
    await Promise.all(part.map(async (s) => {
      for (const src of (s.sources || []).slice(0, 3)) {
        const a = await fetchArticle(src.link);
        if (a.url && a.url !== src.link && !/news\.google\.com/.test(a.url)) src.link = a.url;
        if (a.image && !BAD_IMAGE.test(a.image)) { s.image = a.image; src.image = a.image; own++; return; }
      }
    }));
  }
  picStats.own = own;
  log(`Pictures from the stories' own articles: ${own} of ${need.length}.`);
  need = need.filter((s) => !s.image);
  if (!need.length) return;

  // 0a. ask as a link-preview bot (works for many sites that block us otherwise)
  let prev = 0;
  for (const part of chunk(need, 6)) {
    await Promise.all(part.map(async (s) => {
      for (const src of (s.sources || []).slice(0, 2)) {
        if (/news\.google\.com/.test(src.link)) continue;
        const img = await previewImage(src.link);
        if (img) { s.image = img; src.image = img; prev++; return; }
      }
    }));
  }
  picStats.preview = prev;
  log(`Pictures via link-preview requests: ${prev} of ${need.length}.`);
  need = need.filter((s) => !s.image);
  if (!need.length) return;

  // 0c. Microlink link-preview service, for the newest stories still without one
  let ml = 0;
  for (const s of need.slice(0, 45)) {
    const link = (s.sources || []).map((x) => x.link).find((l) => l && !/news\.google\.com/.test(l));
    if (!link) continue;
    const img = await microlinkImage(link);
    if (img) { s.image = img; ml++; }
  }
  picStats.microlink = ml;
  log(`Pictures via Microlink: ${ml}.`);
  need = need.filter((s) => !s.image);
  if (!need.length) return;

  // 0d. news search engines: the publisher's own thumbnail for sites that block us (WSJ, Reuters…)
  const searchHits = await newsSearchImages(need, apiKey);
  need = need.filter((s) => !s.image);
  if (!need.length) return;

  // 1. a search query for each story
  for (const part of chunk(need, 60)) {
    try {
      const input = await callDirect({
        model: MODEL, max_tokens: 4000,
        system: 'For each news headline, write a short search query that would find other outlets reporting the same event. Call record_queries once.',
        tools: [QUERY_TOOL], tool_choice: { type: 'tool', name: 'record_queries' },
        messages: [{ role: 'user', content: part.map((s, i) => `[${i}] ${s.headline || s.claim}`).join('\n') }]
      }, apiKey);
      for (const it of input.items || []) if (part[it.i]) part[it.i]._q = trim(it.query || '', 100);
    } catch (e) { if (e.fatal) throw e; log(`Picture search queries skipped: ${e.message}`); }
  }

  // 2. candidate articles from other outlets (Bing first, then GDELT for the rest while time allows)
  const ownHosts = (s) => new Set((s.sources || []).map((x) => hostOf(x.link)));
  const usable = (s, list) => {
    const own = ownHosts(s);
    const seen = new Set();
    return list.filter((c) => c.image && !BAD_IMAGE.test(c.image) && /^https:\/\//.test(c.image) && !own.has(hostOf(c.link)) && !/news\.google\.com/.test(c.link))
      .filter((c) => { const k = c.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 8);
  };
  for (const part of chunk(need, 6)) {
    await Promise.all(part.map(async (s) => {
      const q = s._q || (s.headline || s.claim || '').slice(0, 90);
      s._cands = usable(s, await bingNews(q));
    }));
  }
  for (const s of need) {
    if (s._cands.length >= 2 || Date.now() - started > 6 * 60e3) continue;
    s._cands = usable(s, [...s._cands, ...await gdelt(s._q || (s.headline || '').slice(0, 80))]);
  }

  // 3. an AI check that the other article really is the same story
  const withCands = need.filter((s) => s._cands.length);
  let found = 0;
  for (const part of chunk(withCands, 15)) {
    let items = [];
    try {
      const input = await callDirect({
        model: MODEL, max_tokens: 2000,
        system: 'You match news stories to articles from other outlets so the app can borrow a picture. For each story, pick the candidate that reports the SAME specific event. If none clearly does, answer -1: a wrong picture is worse than none. Call record_matches once.',
        tools: [MATCH_TOOL], tool_choice: { type: 'tool', name: 'record_matches' },
        messages: [{ role: 'user', content: part.map((s, i) => `Story [${i}]: ${s.headline || s.claim}\n   ${trim(s.summary || '', 220)}\n${s._cands.map((c, j) => `   (${j}) ${c.outlet}: ${c.title}`).join('\n')}`).join('\n\n') }]
      }, apiKey);
      items = input.items || [];
    } catch (e) { if (e.fatal) throw e; log(`Picture check skipped: ${e.message}`); continue; }
    await Promise.all(items.map(async (it) => {
      const s = part[it.i];
      const c = s?._cands?.[it.match];
      if (!c) return;
      // prefer the article's own full-size picture; fall back to the search thumbnail
      let img = '';
      if (!/bing\.com\/th\?/.test(c.image)) img = c.image;
      else { const a = await fetchArticle(c.link); img = a.image && !BAD_IMAGE.test(a.image) ? a.image : c.image; }
      if (img) { s.image = img; s.image_credit = c.outlet; s.image_link = c.link; found++; }
    }));
  }
  for (const s of need) { s.pic_checked = (s.pic_checked || 0) + 1; delete s._q; delete s._cands; }
  picStats.otherOutlets = found;
  picStats.missing = need.length - found;
  log(`Pictures from other outlets: found ${found} of ${need.length} stories that had none (${withCands.length} had candidates).`);
}

// ---------- "Today in Tech / Finance / World" covers ----------
const SECTION_TOOL = {
  name: 'record_section_brief',
  description: 'Record the section summary.',
  input_schema: { type: 'object', properties: {
    lead_story_id: { type: 'string', description: 'Id of the single most important story right now.' },
    title: { type: 'string', description: 'The main topic of the day as a headline, max 70 chars, in your own words.' },
    notification: { type: 'string', description: 'A catchy one-line teaser of the biggest story for a phone notification, max 110 characters, in your own words, no emoji, no clickbait: make the reader want to open the app.' },
    summary: { type: 'string', description: 'A proper overview of the main events in this area today: 2-3 short paragraphs separated by a blank line (about 150-220 words), covering the biggest stories, what they mean and how they connect. Your own words; never invent facts.' },
    points: { type: 'array', description: '4-6 other key things happening, each tied to a story.', items: { type: 'object', properties: {
      story_id: { type: 'string' }, text: { type: 'string', description: 'One sentence, max 120 chars.' }
    }, required: ['story_id', 'text'] } },
    movers: { type: 'array', description: 'Up to 6 stocks, indices, currencies or commodities most affected by today\u2019s news in this area (Yahoo Finance symbols).', items: { type: 'object', properties: {
      ticker: { type: 'string' }, name: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'mixed'] }, note: { type: 'string', description: 'Max 80 chars.' }
    }, required: ['ticker', 'name', 'direction', 'note'] } }
  }, required: ['lead_story_id', 'title', 'notification', 'summary', 'points', 'movers'] }
};
const SECTION_FOCUS = {
  Tech: 'tech, AI, gadgets, big tech companies, startups and venture capital',
  Finance: 'markets, companies, earnings, deals, central banks and the economy in the US, the UK, Europe and Asia',
  World: 'major world and political news in the US, the UK, Europe and Asia, and what it could mean for markets',
  Fashion: 'luxury and high fashion: luxury houses and groups, major designers and creative directors, the big fashion weeks, and the business of luxury'
};

export async function makeSectionBriefs(stories, apiKey, now = new Date()) {
  const since = new Date(now.getTime() - 26 * 3600e3).toISOString();
  const score = (s) => (s.sources?.length || 1) * 2 + (IMPACT_RANK[s.overall_impact] || 0) * 2 + (s.image ? 1 : 0);
  const out = {};
  await runParallel(Object.keys(SECTION_FOCUS), PARALLEL, async (sec) => {
    const recent = stories.filter((s) => normSection(s.section) === sec && ((s.first_published || s.first_seen || '') >= since || (s.last_updated || '') >= since))
      .sort((a, b) => score(b) - score(a));
    const global = sec === 'World' || sec === 'Finance';
    // World and Finance cover every region: the biggest stories from each, then the rest
    const pool = global ? fairOrder(recent.map((s) => ({ ...s, region: s.region || 'Global' }))).slice(0, 80) : recent.slice(0, 60);
    if (pool.length < 3) return;
    const ids = new Set(pool.map((s) => s.id));
    try {
      const x = await callClaude({
        model: BRIEFING_MODEL, max_tokens: 3500,
        system: `You are the ${sec} editor of a news app read in the UK, the US, Europe and Asia. Using only the stories given, say what the main topic in ${SECTION_FOCUS[sec]} is right now and summarise what is happening. ${global ? 'Cover every region: after the biggest story, give the US, the UK, Europe and Asia a short paragraph each where there is real news (4-5 short paragraphs, about 250-350 words in all), and spread the points across regions. ' : ''}Neutral, British English, your own words. Call record_section_brief once.`,
        tools: [SECTION_TOOL], tool_choice: { type: 'tool', name: 'record_section_brief' },
        messages: [{ role: 'user', content: pool.map((s) => `${s.id} | ${s.region || 'Global'} | ${s.sources.length} outlet(s) | ${s.status} | ${s.headline || s.claim}\n   ${s.summary}${(s.stocks || []).length ? '\n   Stocks: ' + s.stocks.map((k) => `${k.ticker} ${k.direction}`).join(', ') : ''}`).join('\n') }]
      }, apiKey);
      out[sec] = {
        generated: now.toISOString(),
        lead_story_id: ids.has(x.lead_story_id) ? x.lead_story_id : pool[0].id,
        title: trim(x.title, 100),
        notification: trim(x.notification, 140),
        summary: trimKeepParas(x.summary, global ? 3200 : 2000),
        points: (x.points || []).filter((p) => ids.has(p.story_id)).slice(0, 6).map((p) => ({ story_id: p.story_id, text: trim(p.text, 160) })),
        movers: (x.movers || []).filter((m) => /^[A-Z0-9.\-^=]{1,15}$/i.test(m.ticker || '')).slice(0, 6).map((m) => ({
          ticker: m.ticker.toUpperCase(), name: trim(m.name, 50), direction: ['up', 'down', 'mixed'].includes(m.direction) ? m.direction : 'mixed', note: trim(m.note, 100)
        }))
      };
    } catch (e) { if (e.fatal) throw e; log(`${sec} summary skipped: ${e.message}`); }
  });
  log(`Section summaries written: ${Object.keys(out).join(', ') || 'none'}.`);
  return out;
}

// ---------- Main ----------
export async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\n❌ ANTHROPIC_API_KEY is missing. Add it on GitHub: Settings → Secrets and variables → Actions → New repository secret.\n');
    process.exit(1);
  }
  const feeds = await readJSON(FEEDS_FILE, []);
  const news = await readJSON(NEWS_FILE, { updated: null, stories: [] });
  let seen = await readJSON(SEEN_FILE, []);
  // Once: clear out fashion stories from the broad sources that were removed (local fashion weeks, regional retail…).
  if (!news.fashion_v2) {
    const LUXURY = /WWD|Business of Fashion|Financial Times|^FT|Vogue|Telegraph|Guardian|Harper|Highsnobiety|Hypebeast|Elle|GQ|Reuters|Bloomberg|Wall Street Journal|WSJ|New York Times|Economist|Jing Daily|Robb Report/i;
    const before = news.stories.length;
    news.stories = news.stories.filter((x) => normSection(x.section) !== 'Fashion' || LUXURY.test(x.sources?.[0]?.name || ''));
    news.fashion_v2 = 1;
    log(`Fashion clean-up: removed ${before - news.stories.length} off-topic stories.`);
  }
  // Check the page date of stories already in the app (once each): drop re-dated old ones.
  if ((process.env.MODE || 'full').toLowerCase() === 'full') {
    const unchecked = news.stories.filter((x) => !x.date_checked).slice(0, 400);
    let dropped = 0;
    for (const part of chunk(unchecked, 10)) {
      await Promise.all(part.map(async (st) => {
        st.date_checked = 1;
        const link = (st.sources || []).map((x) => x.link).find((l) => l && !/news\.google\.com/.test(l));
        if (!link) return;
        const a = await fetchArticle(link);
        if (a.published && isStale({ pagePublished: a.published, section: normSection(st.section) })) { st._stale = true; dropped++; }
      }));
    }
    news.stories = news.stories.filter((x) => !x._stale);
    if (unchecked.length) log(`Checked the page dates of ${unchecked.length} stories; removed ${dropped} old ones.`);
  }
  // Once: give fashion articles skipped by older versions a second chance.
  if (!news.fashion_reset) {
    const before = seen.length;
    seen = seen.filter((l) => !/wwd\.com|vogue\.|businessoffashion|harpersbazaar|fashionista|highsnobiety|hypebeast|telegraph\.co\.uk\/fashion|theguardian\.com\/fashion/i.test(l));
    news.fashion_reset = 1;
    log(`Fashion articles given a second look: ${before - seen.length}.`);
  }
  const briefing = await readJSON(BRIEFING_FILE, { editions: [] });

  // Stocks you added in the app arrive with the refresh (as a list of tickers).
  let watchlist = await readJSON(WATCH_FILE, []);
  if (process.env.WATCHLIST !== undefined && process.env.WATCHLIST !== '' ) {
    watchlist = process.env.WATCHLIST === '-' ? [] : [...new Set(process.env.WATCHLIST.split(',').map((x) => x.trim().toUpperCase()).filter(validSymbol))].slice(0, 40);
    await writeJSON(WATCH_FILE, watchlist);
    log(`Watchlist: ${watchlist.join(', ') || '(empty)'}`);
  }
  // Stocks people follow in the Scout iPhone app, so they get prices and AI summaries too.
  const shared = await sharedStocks();
  if (shared.length) log(`Stocks followed in the Scout app: ${shared.length}.`);
  const ai = (body) => callDirect({ model: MODEL, ...body }, apiKey); // stock summaries: small, sent straight away
  const doStocks = async (summariseMode) => {
    try {
      // The newest copy: the one on the Scout service, or the repository's if that's newer.
      const local = await readJSON(STOCKS_FILE, null);
      const remote = await readPublishedStocks();
      const prev = (remote?.pricesUpdated || '') > (local?.pricesUpdated || '') ? remote : local;
      const st = await updateStocks({ prev, watchlist, shared, mentioned: mentionedStocks(news.stories), stories: news.stories, ai, summariseMode });
      await writeJSON(STOCKS_FILE, st);
      // Published to the Scout service instead of saved into the repository (see publish.mjs).
      if (await publishStocks(st)) {
        await fs.writeFile(path.join(DATA_DIR, '..', '.stocks-published'), st.pricesUpdated || 'yes');
        log('Stocks published to the Scout service.');
      } else {
        log('Stocks not published to the Scout service; saving them in the repository instead.');
      }
    } catch (e) {
      if (e.fatal) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
      log(`Stocks update failed, keeping the previous prices: ${e.message}`);
    }
  };

  // Prices for as many stocks as possible (about 3,500), fetched in bulk and published as
  // prices.json, plus yesterday's biggest risers and fallers. Free: no AI, a few minutes on GitHub.
  const doUniverse = async () => {
    const SYMBOLS = path.join(DATA_DIR, 'symbols.json');
    const out = path.join(ROOT, '.universe.json');
    await new Promise((resolve) => execFile(process.env.PYTHON || 'python3', [path.join(ROOT, 'scripts', 'universe.py'), SYMBOLS, out], { timeout: 15 * 60e3, maxBuffer: 1 << 24 }, (err, so, se) => {
      if (so) process.stdout.write(so);
      if (err) log(`Wide price list skipped: ${(se || err.message).split('\n').filter(Boolean).slice(-2).join(' | ')}`);
      resolve();
    }));
    const data = await readJSON(out, null);
    await fs.rm(out, { force: true });
    if (!data?.q || !Object.keys(data.q).length) return;
    log(await publishFile('prices.json', data) ? `Prices for ${Object.keys(data.q).length} stocks published.` : 'Wide price list not published.');
  };

  // Quick updates: 'stocks' when you add a stock or refresh the Stocks tab, 'prices' every 30 minutes on weekdays.
  const MODE = (process.env.MODE || 'full').toLowerCase();

  // Morning notifications: keys, sign-ups from the app, and the ~7:00 send.
  const pushKeys = vapidKeys(process.env.PUSH_SECRET || apiKey);
  await ensurePublicKey(DATA_DIR, pushKeys);
  if (MODE === 'subscribe') { await saveFromApp(DATA_DIR, pushKeys, process.env.PUSH, log); return; }
  if (MODE === 'notify') { await sendMorning(DATA_DIR, pushKeys, briefing, log); return; }

  // The worldwide stock list for the app's search box: built when missing, then once a week.
  if (MODE !== 'prices') {
    const SYMBOLS_FILE = path.join(DATA_DIR, 'symbols.json');
    const st = await fs.stat(SYMBOLS_FILE).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > 7 * 86400e3 || process.env.REBUILD_SYMBOLS) {
      await new Promise((resolve) => execFile(process.env.PYTHON || 'python3', [path.join(ROOT, 'scripts', 'build_symbols.py'), SYMBOLS_FILE], { timeout: 10 * 60e3, maxBuffer: 1 << 24 }, (err, out, errOut) => {
        if (out) process.stdout.write(out);
        if (err) log(`Stock list not rebuilt: ${(errOut || err.message).split('\n').filter(Boolean).slice(-2).join(' | ')}`);
        resolve();
      }));
    }
  }
  if (MODE === 'stocks' || MODE === 'prices') {
    await doStocks(MODE === 'prices' ? 'prices' : 'missing');
    if (MODE === 'prices') await doUniverse();
    log(`${MODE === 'prices' ? 'Prices' : 'Stocks-only'} update done.`);
    return;
  }

  const fresh = await collect(feeds, seen);
  const pool = fresh.slice(0, MAX_TRIAGE);
  log(`${fresh.length} new articles found; checking ${pool.length} headlines.`);
  const done = [];
  const groups = await triageAll(pool, news.stories, apiKey, done);
  let todo = pickFair(groups, MAX_NEW_PER_RUN);
  if (groups.length > todo.length) log(`${groups.length - todo.length} stories left for the next run.`);
  await readArticles(todo.map((g) => g.art));
  // Old articles with a new date: Google News and some sites re-date old pieces,
  // so trust the date printed on the article page itself.
  const stale = todo.filter((g) => isStale(g.art));
  if (stale.length) {
    for (const g of stale) done.push(g.art.link, g.art.feedLink, ...g.extras.map((x) => x.link));
    todo = todo.filter((g) => !stale.includes(g));
    log(`Skipped ${stale.length} old article(s) re-dated as new: ${stale.slice(0, 5).map((g) => g.art.title.slice(0, 50)).join(' | ')}`);
  }

  const stats = { added: 0, merged: 0, dropped: 0 };
  await runParallel(chunk(todo, BATCH_SIZE), PARALLEL, async (batch) => {
    const arts = batch.map((g) => g.art);
    const targets = [...new Set(batch.map((g) => g.target).filter(Boolean))];
    try {
      const analyses = await analyseBatch(arts, targets, apiKey);
      const r = mergeBatch(news.stories, arts, analyses);
      stats.added += r.added; stats.merged += r.merged; stats.dropped += r.dropped;
      const byId = new Map(news.stories.map((s) => [s.id, s]));
      batch.forEach((g, idx) => {
        if (!r.handled.has(idx)) return;
        done.push(g.art.link, g.art.feedLink, ...g.extras.map((x) => x.link));
        const s = byId.get(r.storyOf.get(idx));
        if (!s) return;
        for (const x of g.extras) {
          if (!s.sources.some((y) => y.link === x.link)) s.sources.push(sourceEntry(x));
          if (!s.image && x.image) s.image = x.image;
        }
      });
    } catch (e) {
      if (e.fatal) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
      log(`Skipping batch, will retry next run: ${e.message}`);
    }
  });

  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString();
  for (const s of news.stories) s.sources = (s.sources || []).filter((x) => !BLOCKED.test(x.name) && !BLOCKED.test(x.link));
  const recent = news.stories
    .filter((s) => s.sources.length && (s.first_published || s.first_seen || s.last_updated) >= cutoff)
    .sort((a, b) => b.last_updated.localeCompare(a.last_updated));
  // Each section keeps its newest stories, so busy sections can't push quieter ones (like Fashion) out.
  const keep = new Set();
  const perSection = {};
  for (const s of recent) { const k = normSection(s.section); if ((perSection[k] = (perSection[k] || 0) + 1) <= SECTION_MIN) keep.add(s); }
  for (const s of recent) { if (keep.size >= MAX_STORIES) break; keep.add(s); }
  news.stories = recent.filter((s) => keep.has(s));
  for (const s of news.stories) {
    if (!s.headline) s.headline = s.sources?.[0]?.title || s.claim;
    s.section = normSection(s.section);
    // fashion stories saved before the Fashion section existed
    if (s.section === 'Tech' && FASHION_OUTLETS.test(s.sources?.[0]?.name || '')) s.section = 'Fashion';
  }
  try { await upgradeOld(news.stories, apiKey); } catch (e) {
    if (e.fatal) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
    log(`Upgrading older stories failed: ${e.message}`);
  }
  try { await fillMissingImages(news.stories, apiKey); } catch (e) {
    if (e.fatal) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
    log(`Wikipedia pictures failed: ${e.message}`);
  }
  news.updated = new Date().toISOString();
  news.model = MODEL;
  news.last_run = { ...stats, at: news.updated, pictures: picStats };

  if (shouldMakeBriefing(briefing)) {
    try {
      const b = await makeBriefing(news.stories, apiKey);
      if (b) {
        briefing.editions = [b, ...(briefing.editions || [])].slice(0, 6);
        log(`${b.edition} briefing written: "${b.title}"`);
      }
    } catch (e) {
      if (e.fatal) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
      log(`Briefing failed, keeping the previous one: ${e.message}`);
    }
  }
  try {
    const secs = await makeSectionBriefs(news.stories, apiKey);
    briefing.sections = { ...(briefing.sections || {}), ...secs };
  } catch (e) {
    if (e.fatal) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
    log(`Section summaries failed: ${e.message}`);
  }
  briefing.updated = new Date().toISOString();

  await doStocks('all');
  await doUniverse();

  await writeJSON(NEWS_FILE, news);
  await writeJSON(BRIEFING_FILE, briefing);
  // Also on the Scout service, where the app gets them within a minute (GitHub's file server can lag).
  const sent = (await Promise.all([publishFile('news.json', news), publishFile('briefing.json', briefing)])).every(Boolean);
  log(sent ? 'News and briefing published to the Scout service.' : 'News and briefing not published to the Scout service (the app falls back to GitHub).');
  await writeJSON(SEEN_FILE, [...done, ...seen].slice(0, MAX_SEEN));
  if (USE_BATCH) log(`AI requests at half price: ${batchStats.done}; sent normally: ${batchStats.fallback}.`);
  log(`Done: ${stats.added} new stories, ${stats.merged} merged into existing, ${stats.dropped} skipped as irrelevant. ${news.stories.length} stories total.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
