// Rumour Radar — stocks.
// Builds data/stocks.json: the 20 largest US-listed companies by market value plus
// the stocks you added in the app, each with price, key stats, 1-day / 1-month /
// 1-year charts, headlines, the app's stories that mention it, and a short AI summary.
// Prices come from Yahoo Finance through the yfinance Python package (scripts/prices.py).
//
// Three modes:
//   all    — twice a day with the news: re-rank the top 20, full data, fresh AI summaries
//   stocks — when you add a stock: full data + AI summary for new stocks, prices for the rest
//   prices — every hour on weekdays: just prices and today's chart, no AI

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRICES_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prices.py');
const TOP_N = 10;
// The world's main stock market benchmarks (Yahoo Finance symbols), shown on the Stocks tab.
// The pound, bitcoin, gold and oil too, for the markets strip in the Scout iPhone app.
export const BENCHMARKS = ['^GSPC', '^DJI', '^IXIC', '^NDX', '^RUT', '^FTSE', '^FTMC', '^GDAXI', '^FCHI', '^STOXX50E', '^N225', '^HSI', '^AXJO', '000001.SS', '000300.SS', '^BSESN', '^NSEI',
  'GBPUSD=X', 'EURGBP=X', 'BTC-USD', 'GC=F', 'BZ=F'];
const MAX_WATCH = 40;
// Stocks people follow in the Scout iPhone app (stocks-worker), most recently asked for first.
// Capped so the AI summaries stay cheap however many people use the app.
export const MAX_SHARED = 120;
// Stocks the latest stories name, for the app's "In the news" list: prices and charts, no AI summaries.
export const MAX_MENTIONED = 60;

// Roughly the largest US-listed companies. The top 20 are picked from these by live market value.
// (The order here is only used if market values can't be fetched.)
export const CANDIDATES = [
  'NVDA', 'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA', 'SPCX', 'TSM', 'BRK-B',
  'LLY', 'JPM', 'WMT', 'V', 'ORCL', 'MA', 'XOM', 'NFLX', 'COST', 'JNJ',
  'PLTR', 'AMD', 'HD', 'PG', 'ABBV', 'BAC', 'UNH', 'ASML', 'KO', 'CRM',
  'NVO', 'SAP', 'BABA', 'TM', 'CVX', 'MU', 'GE', 'IBM', 'CSCO', 'WFC',
  'MS', 'GS', 'AZN', 'TMUS', 'MRK', 'NOW', 'ISRG', 'UBER', 'ARM', 'SHEL'
];

const log = (...a) => console.log('[stocks]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
export const validSymbol = (s) => /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/.test(String(s || '').toUpperCase());

function runPy(symbols, opts) {
  return new Promise(async (resolve) => {
    if (!symbols.length) return resolve({});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-'));
    const inF = path.join(dir, 'in.json'), outF = path.join(dir, 'out.json');
    await fs.writeFile(inF, JSON.stringify({ symbols, ...opts }));
    execFile(process.env.PYTHON || 'python3', [PRICES_PY, inF, outF], { timeout: 15 * 60e3, maxBuffer: 1 << 24 }, async (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (err) log(`Price fetcher problem: ${(stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | ')}`);
      try { resolve(JSON.parse(await fs.readFile(outF, 'utf8'))); } catch { resolve({}); }
    });
  });
}

const LIGHT_KEYS = ['price', 'prevClose', 'change', 'changePct', 'open', 'high', 'low', 'volume', 'marketState', 'time'];
function mergeLight(prevQ, q) {
  const out = { ...prevQ };
  for (const k of LIGHT_KEYS) if (q[k] != null) out[k] = q[k];
  return out;
}
const round = (q) => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v === 'number' && !['volume', 'avgVolume', 'marketCap', 'time'].includes(k) ? r2(v) : v]));

// ---------- matching stories to companies ----------
export function nameKey(q) {
  const base = (q.shortName || q.name || '').replace(/,?\s+(inc\.?|incorporated|corporation|corp\.?|company|co\.?|holdings?|group|plc|ltd\.?|limited|n\.v\.|s\.a\.|ag|se|class [abc]|platforms|technologies|technology|semiconductor manufacturing)\b.*$/i, '').replace(/\(.*?\)/g, '').trim();
  const first = base.split(/\s+/)[0] || '';
  return base.length >= 3 ? (first.length >= 4 && !/^(the|bank|international|american|united|general)$/i.test(first) ? first : base) : '';
}
export function linkedStories(sym, q, stories) {
  const key = nameKey(q);
  const re = key ? new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
  const bare = sym.split(/[.\-]/)[0];
  return stories.filter((s) => (s.stocks || []).some((k) => k.ticker === sym || k.ticker === bare) || (re && re.test(`${s.headline || ''} ${s.claim || ''}`)))
    .sort((a, b) => (b.first_published || b.first_seen || '').localeCompare(a.first_published || a.first_seen || ''));
}

// ---------- AI summaries ----------
const SUMMARY_TOOL = {
  name: 'record_stock_summaries',
  description: 'Record a summary for every company.',
  input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
    symbol: { type: 'string' },
    headline: { type: 'string', description: 'What is happening with the company, as a short headline, max 70 characters.' },
    summary: { type: 'string', description: '2-4 sentences: what is going on with the company and its shares right now, based only on the stories and price moves given. If there are no stories or headlines, say there is no major news right now and describe the price move. Never invent news.' },
    sentiment: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'] }
  }, required: ['symbol', 'headline', 'summary', 'sentiment'] } } }, required: ['items'] }
};

function pct(a, b) { return a != null && b ? r2(((a - b) / b) * 100) : null; }

async function summarise(symbols, data, stories, ai) {
  const out = {};
  for (const part of chunk(symbols, 8)) {
    const blocks = part.map((sym) => {
      const q = data.quotes[sym];
      const ch = data.charts[sym] || {};
      const m1 = ch.m1?.c?.length ? pct(q.price, ch.m1.c[0]) : null;
      const y1 = ch.y1?.c?.length ? pct(q.price, ch.y1.c[0]) : null;
      const rel = linkedStories(sym, q, stories).slice(0, 6);
      const heads = (data.news?.[sym] || []).slice(0, 6);
      const lines = [
        ...rel.map((s) => `- ${s.headline || s.claim} (${(s.sources?.[0]?.name) || ''}, ${String(s.first_published || s.first_seen || '').slice(0, 10)}): ${s.summary || ''}`),
        ...heads.map((h) => `- ${h.title} (${h.source || ''}, ${String(h.published || '').slice(0, 10)})${h.summary ? ': ' + h.summary : ''}`)
      ];
      return `### ${sym} — ${q.name}\nPrice ${q.price} ${q.currency}; today ${q.changePct}%; 1 month ${m1 ?? '?'}%; 1 year ${y1 ?? '?'}%; 52-week range ${q.wk52Low}–${q.wk52High}.\n` +
        (lines.length ? lines.join('\n') : '- (no recent stories or headlines)');
    }).join('\n\n');
    try {
      const x = await ai({
        max_tokens: 3000,
        system: 'You write short, neutral company updates for a stocks screen in a news app. Use only the information given. British English. Not financial advice, so don’t recommend buying or selling. Call record_stock_summaries once with one item per company.',
        tools: [SUMMARY_TOOL], tool_choice: { type: 'tool', name: 'record_stock_summaries' },
        messages: [{ role: 'user', content: blocks }]
      });
      for (const it of x.items || []) {
        if (!part.includes(it.symbol)) continue;
        out[it.symbol] = {
          headline: String(it.headline || '').slice(0, 100),
          summary: String(it.summary || '').slice(0, 700),
          sentiment: ['positive', 'negative', 'mixed', 'neutral'].includes(it.sentiment) ? it.sentiment : 'neutral',
          generated: new Date().toISOString()
        };
      }
    } catch (e) { if (e.fatal) throw e; log(`AI summaries skipped for one batch: ${e.message}`); }
  }
  return out;
}

// ---------- main ----------
export async function updateStocks({ prev, watchlist, shared = [], mentioned = [], stories, ai, summariseMode = 'all' }) {
  const mode = summariseMode === 'all' ? 'all' : summariseMode === 'prices' ? 'prices' : 'stocks';
  const watch = [...new Set((watchlist || []).map((s) => String(s).toUpperCase().trim()).filter(validSymbol))].slice(0, MAX_WATCH);
  // Skip ones that didn't exist last time, so a mistyped ticker isn't looked up every hour.
  const extra = [...new Set((shared || []).map((s) => String(s).toUpperCase().trim()).filter(validSymbol))]
    .filter((s) => !watch.includes(s) && !(prev?.invalid || []).includes(s)).slice(0, MAX_SHARED);
  const named = [...new Set((mentioned || []).map((s) => String(s).toUpperCase().trim()).filter(validSymbol))]
    .filter((s) => !(prev?.invalid || []).includes(s)).slice(0, MAX_MENTIONED);
  // AI summaries only for the biggest companies and the stocks people follow, never just for being named.
  const summarisable = (s) => !named.includes(s) || watch.includes(s) || extra.includes(s) || (prev?.top || CANDIDATES).includes(s);
  const data = {
    updated: new Date().toISOString(),
    pricesUpdated: new Date().toISOString(),
    summariesUpdated: prev?.summariesUpdated || null,
    top: (prev?.top?.length ? prev.top : CANDIDATES).slice(0, TOP_N),
    benchmarks: BENCHMARKS,
    watch,
    shared: extra,
    mentioned: named,
    quotes: {}, charts: {}, news: { ...(prev?.news || {}) }, summaries: { ...(prev?.summaries || {}) }, invalid: []
  };
  const had = (s) => prev?.quotes?.[s]?.price != null && !prev?.invalid?.includes(s);

  if (mode === 'all') {
    // Full data for every candidate (to rank by market value) and every stock you added.
    const syms = [...new Set([...CANDIDATES, ...watch, ...extra, ...named])];
    const res = await runPy(syms, { info: true, charts: ['d1', 'm1', 'y1'], news: syms });
    const withCap = CANDIDATES.filter((s) => res[s]?.quote?.marketCap);
    if (withCap.length >= TOP_N) data.top = withCap.sort((a, b) => res[b].quote.marketCap - res[a].quote.marketCap).slice(0, TOP_N);
    for (const s of [...new Set([...data.top, ...watch, ...extra, ...named])]) {
      if (res[s]?.quote) { data.quotes[s] = round(res[s].quote); data.charts[s] = res[s].charts; if (res[s].news) data.news[s] = res[s].news; }
      else if (had(s)) { data.quotes[s] = prev.quotes[s]; data.charts[s] = prev.charts?.[s] || {}; }
      else data.invalid.push(s);
    }
  } else {
    // Quick runs: full data only for stocks we have nothing on yet, prices for the rest.
    const syms = [...new Set([...data.top, ...watch, ...extra, ...named])];
    const fresh = syms.filter((s) => !had(s));
    const known = syms.filter(had);
    const [full, light] = await Promise.all([
      runPy(fresh, { info: true, charts: ['d1', 'm1', 'y1'], news: fresh }),
      runPy(known, { info: false, charts: ['d1'], news: [] })
    ]);
    for (const s of syms) {
      if (full[s]?.quote) { data.quotes[s] = round(full[s].quote); data.charts[s] = full[s].charts; if (full[s].news) data.news[s] = full[s].news; }
      else if (light[s]?.quote) { data.quotes[s] = mergeLight(prev.quotes[s], round(light[s].quote)); data.charts[s] = { ...(prev.charts?.[s] || {}), d1: light[s].charts.d1 }; }
      else if (had(s)) { data.quotes[s] = prev.quotes[s]; data.charts[s] = prev.charts?.[s] || {}; }
      else data.invalid.push(s);
    }
  }
  // Benchmarks: prices and charts (no AI summaries or headlines needed)
  {
    const freshB = BENCHMARKS.filter((s) => !had(s) || mode === 'all');
    const knownB = BENCHMARKS.filter((s) => !freshB.includes(s));
    const [fb, lb] = await Promise.all([
      runPy(freshB, { info: false, charts: ['d1', 'm1', 'y1'], news: [] }),
      runPy(knownB, { info: false, charts: ['d1'], news: [] })
    ]);
    for (const s of BENCHMARKS) {
      if (fb[s]?.quote) { data.quotes[s] = round(fb[s].quote); data.charts[s] = fb[s].charts; }
      else if (lb[s]?.quote) { data.quotes[s] = mergeLight(prev.quotes[s], round(lb[s].quote)); data.charts[s] = { ...(prev.charts?.[s] || {}), d1: lb[s].charts.d1 }; }
      else if (had(s)) { data.quotes[s] = prev.quotes[s]; data.charts[s] = prev.charts?.[s] || {}; }
    }
    log(`Benchmarks: ${BENCHMARKS.filter((s) => data.quotes[s]).length} of ${BENCHMARKS.length}.`);
  }
  const shown = [...new Set([...data.top, ...watch, ...extra, ...named])];
  log(`Prices for ${Object.keys(data.quotes).length} of ${shown.length} stocks${data.invalid.length ? `; not found: ${data.invalid.join(', ')}` : ''}.`);

  // AI summaries: all of them twice a day, only missing ones when you add a stock, none hourly.
  if (mode !== 'prices' && ai) {
    const ok = shown.filter((s) => data.quotes[s]?.price != null && (summarisable(s) || data.top.includes(s)));
    const need = mode === 'all' ? ok : ok.filter((s) => !data.summaries[s]);
    if (need.length) {
      const fresh = await summarise(need, data, stories, ai);
      Object.assign(data.summaries, fresh);
      if (mode === 'all') data.summariesUpdated = new Date().toISOString();
      log(`AI summaries written for ${Object.keys(fresh).length} stocks.`);
    }
  }
  for (const k of Object.keys(data.summaries)) if (!shown.includes(k)) delete data.summaries[k];
  for (const k of Object.keys(data.news)) if (!shown.includes(k)) delete data.news[k];
  return data;
}
