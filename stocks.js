// Rumour Radar — Stocks tab.
// Top 20 US-listed companies by market value + your own stocks, each with price,
// chart, key stats, an AI summary and the stories that mention it.
(() => {
  'use strict';
  const RR = window.RR;
  if (!RR) return;
  const { $, $$, esc, store, toast } = RR;

  // Popular stocks for the search box (any other Yahoo Finance ticker can be typed in).
  const CATALOG = [
    ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['GOOGL', 'Alphabet (Google)'], ['AMZN', 'Amazon'], ['META', 'Meta Platforms'],
    ['TSLA', 'Tesla'], ['SPCX', 'SpaceX'], ['SMT.L', 'Scottish Mortgage Investment Trust'], ['AVGO', 'Broadcom'], ['TSM', 'TSMC'], ['BRK-B', 'Berkshire Hathaway'], ['LLY', 'Eli Lilly'], ['JPM', 'JPMorgan Chase'],
    ['V', 'Visa'], ['MA', 'Mastercard'], ['WMT', 'Walmart'], ['ORCL', 'Oracle'], ['XOM', 'Exxon Mobil'], ['NFLX', 'Netflix'], ['COST', 'Costco'],
    ['JNJ', 'Johnson & Johnson'], ['PLTR', 'Palantir'], ['AMD', 'AMD'], ['HD', 'Home Depot'], ['PG', 'Procter & Gamble'], ['ABBV', 'AbbVie'],
    ['BAC', 'Bank of America'], ['UNH', 'UnitedHealth'], ['KO', 'Coca-Cola'], ['PEP', 'PepsiCo'], ['CRM', 'Salesforce'], ['ADBE', 'Adobe'],
    ['INTC', 'Intel'], ['QCOM', 'Qualcomm'], ['TXN', 'Texas Instruments'], ['MU', 'Micron'], ['AMAT', 'Applied Materials'], ['LRCX', 'Lam Research'],
    ['ARM', 'Arm Holdings'], ['SMCI', 'Super Micro Computer'], ['DELL', 'Dell'], ['IBM', 'IBM'], ['CSCO', 'Cisco'], ['NOW', 'ServiceNow'],
    ['INTU', 'Intuit'], ['SNOW', 'Snowflake'], ['CRWD', 'CrowdStrike'], ['PANW', 'Palo Alto Networks'], ['NET', 'Cloudflare'], ['DDOG', 'Datadog'],
    ['SHOP', 'Shopify'], ['SPOT', 'Spotify'], ['UBER', 'Uber'], ['ABNB', 'Airbnb'], ['DASH', 'DoorDash'], ['PYPL', 'PayPal'], ['XYZ', 'Block'],
    ['COIN', 'Coinbase'], ['HOOD', 'Robinhood'], ['RBLX', 'Roblox'], ['DIS', 'Disney'], ['MCD', 'McDonald’s'], ['NKE', 'Nike'], ['SBUX', 'Starbucks'],
    ['BA', 'Boeing'], ['LMT', 'Lockheed Martin'], ['RTX', 'RTX'], ['CAT', 'Caterpillar'], ['GE', 'GE Aerospace'], ['F', 'Ford'], ['GM', 'General Motors'],
    ['RIVN', 'Rivian'], ['LCID', 'Lucid'], ['T', 'AT&T'], ['VZ', 'Verizon'], ['TMUS', 'T-Mobile US'], ['PFE', 'Pfizer'], ['MRK', 'Merck'],
    ['MRNA', 'Moderna'], ['CVX', 'Chevron'], ['GS', 'Goldman Sachs'], ['MS', 'Morgan Stanley'], ['WFC', 'Wells Fargo'], ['C', 'Citigroup'],
    ['BABA', 'Alibaba'], ['PDD', 'PDD Holdings (Temu)'], ['JD', 'JD.com'], ['NIO', 'NIO'], ['TM', 'Toyota'], ['SONY', 'Sony'], ['ASML', 'ASML'],
    ['SAP', 'SAP'], ['NVO', 'Novo Nordisk'], ['AZN', 'AstraZeneca'], ['SHEL', 'Shell'], ['BP', 'BP'], ['HSBC', 'HSBC'], ['GSK', 'GSK'], ['RIO', 'Rio Tinto'],
    ['UL', 'Unilever'], ['BARC.L', 'Barclays (London)'], ['LLOY.L', 'Lloyds Banking Group (London)'], ['NWG.L', 'NatWest (London)'],
    ['RR.L', 'Rolls-Royce (London)'], ['VOD.L', 'Vodafone (London)'], ['BT-A.L', 'BT Group (London)'], ['TSCO.L', 'Tesco (London)'],
    ['BA.L', 'BAE Systems (London)'], ['IAG.L', 'IAG – British Airways (London)'], ['BATS.L', 'British American Tobacco (London)'],
    ['ULVR.L', 'Unilever (London)'], ['AZN.L', 'AstraZeneca (London)'], ['SHEL.L', 'Shell (London)'], ['BP.L', 'BP (London)'], ['HSBA.L', 'HSBC (London)'],
    ['LSEG.L', 'London Stock Exchange Group'], ['AUTO.L', 'Auto Trader (London)'], ['OCDO.L', 'Ocado (London)'], ['JD.L', 'JD Sports (London)'],
    ['MKS.L', 'Marks & Spencer (London)'], ['SBRY.L', 'Sainsbury’s (London)'], ['MC.PA', 'LVMH (Paris)'], ['AIR.PA', 'Airbus (Paris)'],
    ['OR.PA', 'L’Oréal (Paris)'], ['NESN.SW', 'Nestlé (Zurich)'], ['SIE.DE', 'Siemens (Frankfurt)'], ['7203.T', 'Toyota (Tokyo)'], ['6758.T', 'Sony (Tokyo)'],
    ['005930.KS', 'Samsung Electronics (Seoul)'], ['0700.HK', 'Tencent (Hong Kong)'], ['9988.HK', 'Alibaba (Hong Kong)'], ['1211.HK', 'BYD (Hong Kong)'],
    ['^GSPC', 'S&P 500 index'], ['^IXIC', 'Nasdaq Composite index'], ['^DJI', 'Dow Jones index'], ['^FTSE', 'FTSE 100 index'], ['^FTMC', 'FTSE 250 index'],
    ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ (Nasdaq 100) ETF'], ['VUSA.L', 'Vanguard S&P 500 ETF (London)'],
    ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['GC=F', 'Gold'], ['CL=F', 'Crude oil'], ['GBPUSD=X', 'Pound / Dollar'], ['EURUSD=X', 'Euro / Dollar']
  ];
  // The world's main stock market benchmarks, by region.
  const BENCH_GROUPS = [
    ['United States', [['^GSPC', 'S&P 500', 'S&P 500'], ['^DJI', 'Dow Jones', 'Dow'], ['^IXIC', 'Nasdaq Composite', 'Nasdaq'], ['^NDX', 'Nasdaq-100', 'Nasdaq 100'], ['^RUT', 'Russell 2000', 'Russell']]],
    ['Europe', [['^FTSE', 'FTSE 100', 'FTSE 100'], ['^FTMC', 'FTSE 250', 'FTSE 250'], ['^GDAXI', 'DAX 40', 'DAX'], ['^FCHI', 'CAC 40', 'CAC 40'], ['^STOXX50E', 'Euro Stoxx 50', 'Stoxx 50']]],
    ['Asia-Pacific', [['^N225', 'Nikkei 225', 'Nikkei'], ['^HSI', 'Hang Seng', 'Hang Seng'], ['^AXJO', 'S&P/ASX 200', 'ASX 200'], ['000001.SS', 'Shanghai Composite', 'Shanghai'], ['000300.SS', 'CSI 300', 'CSI 300'], ['^BSESN', 'BSE Sensex', 'Sensex'], ['^NSEI', 'Nifty 50', 'Nifty 50']]]
  ];
  const BENCH = Object.fromEntries(BENCH_GROUPS.flatMap(([, l]) => l.map(([sym, name, short]) => [sym, { name, short }])));
  const FLAG = {"^GSPC": "🇺🇸", "^DJI": "🇺🇸", "^IXIC": "🇺🇸", "^NDX": "🇺🇸", "^RUT": "🇺🇸", "^FTSE": "🇬🇧", "^FTMC": "🇬🇧", "^GDAXI": "🇩🇪", "^FCHI": "🇫🇷", "^STOXX50E": "🇪🇺", "^N225": "🇯🇵", "^HSI": "🇭🇰", "^AXJO": "🇦🇺", "000001.SS": "🇨🇳", "000300.SS": "🇨🇳", "^BSESN": "🇮🇳", "^NSEI": "🇮🇳"};
  const badge = (name, sym) => (FLAG[sym] ? `<span class="logo idx-flag">${FLAG[sym]}</span>` : RR.logo(name, sym));
  const isIndex = (sym) => !!BENCH[sym] || /^\^/.test(sym);
  const label = (sym) => BENCH[sym]?.short || sym;   // what to show instead of "^GSPC"
  const catalogName = (sym) => BENCH[sym]?.name || (CATALOG.find((c) => c[0] === sym) || [])[1] || '';
  // Index levels are points, not money.
  const priceOf = (sym, q, plain) => (isIndex(sym) ? Number(q.price).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : money(q.price, q.currency, plain));
  const validSymbol = (s) => /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/.test(s);

  // ---------- state ----------
  let data = null;                       // data/stocks.json
  let watch = store.get('rr.watch', []);  // your stocks (kept on this phone)
  let editing = false;
  const chgMode = 'pct'; // the list always shows the % change
  let liveOK = null;                      // can this phone reach Yahoo directly? (null = not tried)
  let liveAt = 0;

  const saveWatch = () => store.set('rr.watch', watch);
  RR.watchlist = () => watch.slice();

  // ---------- formatting ----------
  const SYM = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', CNY: '¥', HKD: 'HK$', CHF: 'CHF ', KRW: '₩', CAD: 'C$', AUD: 'A$', INR: '₹' };
  function money(n, cur, plain) {
    if (n == null || !isFinite(n)) return '—';
    const d = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
    const num = Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
    if (cur === 'GBp' || cur === 'GBX') return `${num}p`;
    if (plain) return num;
    return SYM[cur] ? `${SYM[cur]}${num}` : `${num} ${cur || ''}`.trim();
  }
  function big(n, cur) {
    if (n == null || !isFinite(n)) return '—';
    const a = Math.abs(n);
    const [v, u] = a >= 1e12 ? [n / 1e12, 'T'] : a >= 1e9 ? [n / 1e9, 'B'] : a >= 1e6 ? [n / 1e6, 'M'] : a >= 1e3 ? [n / 1e3, 'K'] : [n, ''];
    const s = `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)}${u}`;
    return cur ? `${SYM[cur] || ''}${s}` : s;
  }
  const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
  const pctStr = (n) => (n == null ? '—' : `${sign(n)}${Math.abs(n).toFixed(2)}%`);
  const dirOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const timeLondon = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const stateLabel = (s) => ({ REGULAR: 'Market open', PRE: 'Pre-market', PREPRE: 'Pre-market', POST: 'After hours', POSTPOST: 'After hours' }[s] || 'Market closed');

  // ---------- data ----------
  async function loadData() {
    try {
      // Prices live on the Scout service (updated every 30 minutes); the repository's copy is the fallback.
      let r = await fetch('https://scout-stocks.ralph-gebara.workers.dev/stocks.json?t=' + Date.now(), { cache: 'no-store' }).catch(() => null);
      if (!r || !r.ok) r = await fetch('data/stocks.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch { /* keep what we have */ }
    render();
    autoSync();
  }
  // If this phone's list has stocks GitHub doesn't know about yet (e.g. after reinstalling the app),
  // send the list once so the next update fetches their prices.
  let autoSynced = false;
  function autoSync() {
    if (autoSynced || !data || !RR.hasLiveKey()) return;
    const known = new Set([...(data.watch || []), ...(data.invalid || [])]);
    if (watch.some((s) => !known.has(s) && !quote(s))) { autoSynced = true; scheduleSync(); }
  }
  RR.syncWatchlist = () => { autoSynced = false; autoSync(); };
  const quote = (sym) => data?.quotes?.[sym] || null;
  const chartOf = (sym) => data?.charts?.[sym] || {};

  // The phone tries to fetch live prices straight from Yahoo; if that's blocked it quietly uses the last update.
  async function tryLive() {
    if (liveOK === false || !data || Date.now() - liveAt < 60e3 || document.hidden) return;
    liveAt = Date.now();
    const syms = [...new Set([...watch, ...(data.top || [])])].slice(0, 30);
    const one = async (sym) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=false`, { signal: ctrl.signal });
        if (!r.ok) return false;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if (!res) return false;
        const m = res.meta || {};
        const q = data.quotes[sym] || (data.quotes[sym] = { symbol: sym, name: m.longName || m.shortName || catalogName(sym) || sym, currency: m.currency });
        const prev = q.prevClose ?? m.chartPreviousClose;
        q.price = m.regularMarketPrice ?? q.price;
        if (prev) { q.change = q.price - prev; q.changePct = (q.change / prev) * 100; }
        q.high = m.regularMarketDayHigh ?? q.high; q.low = m.regularMarketDayLow ?? q.low; q.volume = m.regularMarketVolume ?? q.volume;
        const p = m.currentTradingPeriod?.regular;
        q.marketState = p && Date.now() / 1000 >= p.start && Date.now() / 1000 < p.end ? 'REGULAR' : 'CLOSED';
        const c = res.indicators?.quote?.[0]?.close || [];
        const pts = { t: [], c: [] };
        (res.timestamp || []).forEach((ts, i) => { if (typeof c[i] === 'number') { pts.t.push(ts); pts.c.push(c[i]); } });
        (data.charts[sym] || (data.charts[sym] = {})).d1 = pts;
        return true;
      } catch { return false; } finally { clearTimeout(t); }
    };
    const first = await one(syms[0]);
    if (!first) { liveOK = false; return; }
    liveOK = true;
    await Promise.all(syms.slice(1).map(one));
    data.liveAt = new Date().toISOString();
    render();
  }

  // ---------- small chart for rows ----------
  function spark(sym) {
    const q = quote(sym);
    const d = chartOf(sym).d1;
    if (!d || d.c.length < 2) return '<svg class="spark" viewBox="0 0 64 30"></svg>';
    const base = q?.prevClose ?? d.c[0];
    const vals = d.c;
    const min = Math.min(...vals, base), max = Math.max(...vals, base);
    const span = max - min || 1;
    const y = (v) => 27 - ((v - min) / span) * 24;
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 64).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const up = vals[vals.length - 1] >= base;
    return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 64 30" preserveAspectRatio="none">
      <line x1="0" x2="64" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}" class="base"/>
      <polyline points="${pts}"/></svg>`;
  }

  function chgText(q) {
    if (!q) return '—';
    if (chgMode === 'abs') return q.change == null ? '—' : `${sign(q.change)}${money(Math.abs(q.change), q.currency, true)}`;
    if (chgMode === 'cap') return q.marketCap ? big(q.marketCap) : pctStr(q.changePct);
    return pctStr(q.changePct);
  }

  function rowHTML(sym, rank) {
    const q = quote(sym);
    const name = BENCH[sym]?.name || q?.shortName || q?.name || catalogName(sym) || '';
    const missing = !q || q.price == null;
    const bad = data?.invalid?.includes(sym);
    return `<div class="stk-row${editing && rank == null ? ' editing' : ''}" data-stock="${esc(sym)}">
      ${editing && rank == null ? `<button class="stk-del" data-del="${esc(sym)}" aria-label="Remove ${esc(sym)}"><i></i></button>` : ''}
      ${rank != null ? `<span class="stk-rank">${rank}</span>` : ''}
      <div class="stk-id"><b>${esc(label(sym))}</b><span>${esc(bad ? 'Ticker not found' : missing ? (RR.hasLiveKey() ? 'Fetching price…' : 'Turn on Live refresh in Settings') : name)}</span></div>
      ${missing ? '<span class="spark"></span>' : spark(sym)}
      <div class="stk-px">
        <span class="p">${missing ? '' : priceOf(sym, q, true)}</span>
        ${missing ? '<span class="chg flat">—</span>' : `<span class="chg ${dirOf(q.changePct)}">${esc(chgText(q))}</span>`}
      </div>
    </div>`;
  }

  // ---------- Stocks tab ----------
  function render() {
    const list = $('#stockList');
    if (!list) return;
    if (RR.isDesktop?.()) { RR.renderTicker?.(); RR.rerenderNews?.(); RR.dkTodaySide?.(); }
    $('#stkEdit').textContent = editing ? 'Done' : 'Edit';
    $('#stkEdit').hidden = !watch.length && !editing;
    if (!data || !data.top) {
      $('#stkAsOf').textContent = 'Waiting for the first update';
      list.innerHTML = RR.empty('📈', 'Stock prices are on their way', RR.hasLiveKey()
        ? 'Tap refresh at the top to fetch them now (about a minute).'
        : 'They arrive with the next update at 5:00. Turn on Live refresh in Settings to fetch them any time.');
      return;
    }
    const lead = quote(data.top[0]);
    const when = data.liveAt && liveOK ? `Live · ${timeLondon(data.liveAt)}` : `Prices as of ${timeLondon(data.pricesUpdated || data.updated)}`;
    $('#stkAsOf').textContent = `${when} · ${stateLabel(lead?.marketState)}`;
    let html = '';
    if (watch.length) {
      html += RR.sectionHead('My stocks & ETFs', `${watch.length}`);
      html += RR.isDesktop?.() && !editing
        ? `<div class="dk-scards">${watch.map((s) => cardHTML(s)).join('')}</div>`
        : `<div class="list stk-list">${watch.map((s) => rowHTML(s, null)).join('')}</div>`;
    } else {
      html += RR.sectionHead('My stocks & ETFs', '');
      html += `<button class="stk-empty-add" data-open-add><span class="plus">+</span><span><b>Add your own stocks and ETFs</b><small>Search any company, ETF, index or currency</small></span></button>`;
    }
    html += RR.sectionHead('Top 10 by market value', 'US-listed');
    html += RR.isDesktop?.()
      ? `<div class="dk-scards">${data.top.map((s, i) => cardHTML(s, i + 1)).join('')}</div>`
      : `<div class="list stk-list">${data.top.map((s, i) => rowHTML(s, i + 1)).join('')}</div>`;
    // Global benchmarks, by region
    const haveB = BENCH_GROUPS.some(([, l]) => l.some(([sym]) => quote(sym)?.price != null));
    html += RR.sectionHead('Global benchmarks', 'Main stock market indices');
    if (!haveB) {
      html += `<p class="disclaimer" style="margin-top:0">The world’s main indices (S&P 500, FTSE 100, DAX, Nikkei and more) arrive with the next update.</p>`;
    } else {
      for (const [region, list] of BENCH_GROUPS) {
        const syms = list.map(([sym]) => sym).filter((sym) => quote(sym)?.price != null);
        if (!syms.length) continue;
        html += `<div class="bench-region">${esc(region)}</div>`;
        html += RR.isDesktop?.()
          ? `<div class="dk-scards">${syms.map((sym) => cardHTML(sym)).join('')}</div>`
          : `<div class="list stk-list">${syms.map((sym) => rowHTML(sym, null)).join('')}</div>`;
      }
    }
    html += '<p class="disclaimer">Prices from Yahoo Finance, which may be delayed. Index levels are in points. Not financial advice.</p>';
    list.innerHTML = html;
  }

  // ---------- desktop: a card per stock in "My stocks" ----------
  let cgid = 0;
  function cardChart(sym) {
    const q = quote(sym);
    const ch = chartOf(sym);
    const d = ch.d1 && ch.d1.c.length > 1 ? ch.d1 : ch.m1;
    if (!d || d.c.length < 2) return '<div class="dk-sc-nochart">No chart yet</div>';
    const W = 300, H = 92;
    const base = d === ch.d1 ? (q?.prevClose ?? d.c[0]) : d.c[0];
    const vals = d.c;
    const min = Math.min(...vals, base), max = Math.max(...vals, base);
    const span = max - min || 1;
    const y = (v) => (H - 6 - ((v - min) / span) * (H - 12)).toFixed(1);
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${y(v)}`);
    const up = vals[vals.length - 1] >= base;
    const id = `cg${++cgid}`;
    return `<svg class="dk-sc-chart ${up ? 'up' : 'down'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}" class="base"/>
      <polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="url(#${id})"/>
      <polyline points="${pts.join(' ')}"/></svg>`;
  }
  // % change over the 1-month chart's last 5 points (about a week) and over the 1-year chart.
  const chartChange = (c, back) => { if (!c || c.length < 2) return null; const a = c[Math.max(0, c.length - 1 - back)]; const b = c[c.length - 1]; return a ? ((b - a) / a) * 100 : null; };
  const weekChange = (sym) => chartChange(chartOf(sym).m1?.c, 5);
  const yearChange = (sym) => chartChange(chartOf(sym).y1?.c, 1e9);
  function cardHTML(sym, rank) {
    const q = quote(sym);
    const name = BENCH[sym]?.name || q?.shortName || q?.name || catalogName(sym) || sym;
    const s = data?.summaries?.[sym];
    if (!q || q.price == null) {
      return `<div class="dk-sc" data-stock="${esc(sym)}"><div class="dk-sc-top">${RR.logo(name, sym)}<div class="id"><b>${esc(sym)}</b><span>${esc(name)}</span></div></div>
        <div class="dk-sc-nochart">${data?.invalid?.includes(sym) ? 'Ticker not found' : RR.hasLiveKey() ? 'Fetching the price — this takes about a minute…' : 'No price yet: add your Live refresh key in Settings so Scout can fetch your stocks'}</div></div>`;
    }
    return `<div class="dk-sc" data-stock="${esc(sym)}">
      <div class="dk-sc-top">${badge(name, sym)}
        <div class="id"><b>${rank ? `<em class="rk">${rank}</em>` : ''}${esc(label(sym))}</b><span>${esc(name)}</span></div>
        <div class="px"><b>${priceOf(sym, q)}</b><span class="chg ${dirOf(q.changePct)}">${pctStr(q.changePct)}</span></div>
      </div>
      ${cardChart(sym)}
      <div class="dk-sc-stats">
        <div><span>Today</span><b class="${dirOf(q.change)}">${q.change == null ? '—' : `${sign(q.change)}${Math.abs(q.change).toFixed(2)}`}</b></div>
        ${isIndex(sym) ? `<div><span>Week</span><b class="${dirOf(weekChange(sym))}">${pctStr(weekChange(sym))}</b></div><div><span>Year</span><b class="${dirOf(yearChange(sym))}">${pctStr(yearChange(sym))}</b></div>`
          : `<div><span>Mkt cap</span><b>${big(q.marketCap, q.currency)}</b></div><div><span>P/E</span><b>${q.pe != null ? Number(q.pe).toFixed(1) : '—'}</b></div>`}
      </div>
      ${q.low != null && q.high != null && q.high > q.low ? `<div class="dk-sc-range"><span>${money(q.low, q.currency, true)}</span>
        <i><em style="left:${Math.max(0, Math.min(100, ((q.price - q.low) / (q.high - q.low)) * 100)).toFixed(1)}%"></em></i>
        <span>${money(q.high, q.currency, true)}</span><small>Day range</small></div>` : ''}
      ${s ? `<p class="dk-sc-ai"><span class="${esc(s.sentiment || '')}">✦ ${esc(s.sentiment || 'AI')}</span> ${esc(s.headline || '')}</p>` : ''}
    </div>`;
  }

  // ---------- big chart on the stock page ----------
  let gid = 0;
  function drawChart(box, sym, range) {
    const q = quote(sym);
    const d = chartOf(sym)[range];
    const lbl = box.querySelector('.sd-range-lbl');
    const area = box.querySelector('.sd-chart');
    if (!d || d.c.length < 2) { area.innerHTML = '<div class="sd-nochart">No chart data yet</div>'; lbl.textContent = ''; return; }
    const W = 340, H = 170, P = 6;
    const base = range === 'd1' ? (q?.prevClose ?? d.c[0]) : d.c[0];
    const vals = d.c;
    const min = Math.min(...vals, range === 'd1' ? base : Infinity), max = Math.max(...vals, range === 'd1' ? base : -Infinity);
    const span = max - min || 1;
    const x = (i) => (i / (vals.length - 1)) * W;
    const y = (v) => P + (1 - (v - min) / span) * (H - 2 * P);
    const last = vals[vals.length - 1];
    const up = last >= base;
    const id = `g${++gid}`;
    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    area.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${up ? 'up' : 'down'}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s0"/><stop offset="1" class="s1"/></linearGradient></defs>
      ${range === 'd1' ? `<line x1="0" x2="${W}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}" class="base"/>` : ''}
      <path d="${line}L${W} ${H}L0 ${H}z" fill="url(#${id})" class="area"/>
      <path d="${line}" class="ln"/>
      <line class="cursor" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
      <circle class="dot" r="4.5" cx="0" cy="0" visibility="hidden"/>
    </svg>`;
    const change = last - base;
    const changePct = base ? (change / base) * 100 : 0;
    const word = { d1: 'today', m1: 'past month', y1: 'past year' }[range];
    const summary = `<span class="${dirOf(change)}">${sign(change)}${money(Math.abs(change), q?.currency, true)} (${pctStr(changePct)})</span> ${word}`;
    lbl.innerHTML = summary;

    // Touch the chart to read a price.
    const svg = area.querySelector('svg');
    const cur = svg.querySelector('.cursor'), dot = svg.querySelector('.dot');
    const fmtT = (ts) => new Date(ts * 1000).toLocaleString('en-GB', range === 'd1' ? { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' } : { day: 'numeric', month: 'short', year: range === 'y1' ? 'numeric' : undefined, timeZone: 'Europe/London' });
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(vals.length - 1, Math.round(((clientX - r.left) / r.width) * (vals.length - 1))));
      const cx = x(i), cy = y(vals[i]);
      cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
      const ch = vals[i] - base;
      lbl.innerHTML = `<b>${money(vals[i], q?.currency)}</b> <span class="${dirOf(ch)}">${pctStr(base ? (ch / base) * 100 : 0)}</span> · ${esc(fmtT(d.t[i]))}`;
    };
    const hide = () => { cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); lbl.innerHTML = summary; };
    svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture?.(e.pointerId); show(e.clientX); });
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') show(e.clientX); });
    svg.addEventListener('pointerup', hide);
    svg.addEventListener('pointercancel', hide);
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  }

  // ---------- stock page ----------
  function related(sym, q) {
    const stories = RR.stories();
    const base = (q?.shortName || q?.name || catalogName(sym) || '').replace(/,?\s+(inc\.?|incorporated|corporation|corp\.?|company|co\.?|holdings?|group|plc|ltd\.?|limited|n\.v\.|s\.a\.|ag|se|class [abc]|platforms|technologies|technology|\(.*\)).*$/i, '').trim();
    const first = base.split(/\s+/)[0] || '';
    const key = base.length >= 3 ? (first.length >= 4 && !/^(the|bank|international|american|united|general)$/i.test(first) ? first : base) : '';
    const re = key ? new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
    const bare = sym.split(/[.\-]/)[0];
    return stories.filter((s) => (s.stocks || []).some((k) => k.ticker === sym || k.ticker === bare) || (re && re.test(`${s.headline || ''} ${s.claim || ''}`)))
      .sort((a, b) => RR.pubTime(b).localeCompare(RR.pubTime(a)));
  }

  function stat(label, value) { return `<div class="sd-stat"><span>${label}</span><b>${value}</b></div>`; }

  function openStock(sym, backLabel) {
    sym = String(sym).toUpperCase();
    const q = quote(sym);
    const name = q?.name || catalogName(sym) || sym;
    const inWatch = watch.includes(sym);
    const s = data?.summaries?.[sym];
    const rel = related(sym, q).slice(0, 25);

    let html = `<div class="sd">
      <div class="sd-head">${badge(name, sym)}<div><h1>${esc(label(sym))}</h1><div class="sub">${esc(name)}${q?.exchange ? ` · ${esc(q.exchange)}` : ''}</div></div></div>`;
    if (q && q.price != null) {
      html += `<div class="sd-price">${priceOf(sym, q)}</div>
        <div class="sd-chg ${dirOf(q.change)}">${q.change > 0 ? '▲' : q.change < 0 ? '▼' : ''} ${isIndex(sym) ? Math.abs(q.change ?? 0).toFixed(2) : money(Math.abs(q.change ?? 0), q.currency, true)} (${pctStr(q.changePct)}) <span>today</span></div>
        <div class="sd-asof">${esc(stateLabel(q.marketState))} · ${esc(data.liveAt && liveOK ? 'live ' + timeLondon(data.liveAt) : 'as of ' + timeLondon(data.pricesUpdated || data.updated))} · prices update hourly on weekdays</div>
        <section class="card sd-chart-card">
          <div class="segmented sd-seg"><button data-r="d1" class="on">1D</button><button data-r="m1">1M</button><button data-r="y1">1Y</button></div>
          <div class="sd-range-lbl"></div>
          <div class="sd-chart"></div>
        </section>
        <section class="card sd-stats">
          ${stat('Open', money(q.open, q.currency, true))}${stat('Prev close', money(q.prevClose, q.currency, true))}
          ${stat('High', money(q.high, q.currency, true))}${stat('Low', money(q.low, q.currency, true))}
          ${stat('Volume', big(q.volume))}${stat('Avg vol', big(q.avgVolume))}
          ${stat('Mkt value', big(q.marketCap, q.currency))}${stat('P/E', q.pe != null ? q.pe.toFixed(1) : '—')}
          ${stat('52W high', money(q.wk52High, q.currency, true))}${stat('52W low', money(q.wk52Low, q.currency, true))}
          ${stat('Div yield', q.divYield != null ? q.divYield.toFixed(2) + '%' : '—')}${stat('EPS', q.eps != null ? money(q.eps, q.currency, true) : '—')}
        </section>`;
    } else {
      html += `<section class="card"><p>${data?.invalid?.includes(sym) ? 'Yahoo Finance doesn’t recognise this ticker. Check it, remove it, and try another (London shares end in .L, for example BARC.L).' : 'Prices and chart arrive with the next update.'}</p></section>`;
    }
    if (s) {
      html += `<section class="card"><div class="card-title"><h2><span class="sparkle">✦</span> What’s happening</h2><span class="sent-pill ${s.sentiment}">${esc(s.sentiment)}</span></div>
        <p><b>${esc(s.headline)}</b></p><p>${esc(s.summary)}</p>
        <p class="sd-note">Scout AI summary · ${esc(timeLondon(s.generated))} · refreshed with your morning briefing</p></section>`;
    } else if (q && q.price != null && !isIndex(sym)) {
      html += `<section class="card"><div class="card-title"><h2><span class="sparkle">✦</span> What’s happening</h2></div>
        <p class="sd-note" style="font-size:14px">The Scout AI summary is on its way${RR.hasLiveKey() ? ' (about a minute after adding)' : ''}, and it’s refreshed with every morning briefing.</p></section>`;
    }
    const heads = (data?.news?.[sym] || []).slice(0, 8);
    if (heads.length) {
      html += RR.sectionHead('Latest headlines', '');
      html += `<div class="list sd-heads">${heads.map((h) => `<a class="sd-head-row" href="${esc(h.link)}" target="_blank" rel="noopener">
        <div><div class="t">${esc(h.title)}</div><div class="m">${esc(h.source || '')}${h.published ? ' · ' + esc(RR.ago(h.published)) : ''}</div></div>${RR.chevron}</a>`).join('')}</div>`;
    }
    if (rel.length || !heads.length) {
      html += RR.sectionHead('In your news', rel.length ? String(rel.length) : '');
      html += rel.length ? `<div class="list">${rel.map(RR.row).join('')}</div>` : `<p class="sd-none">No stories about ${esc(sym)} in the app’s news in the last few days.</p>`;
    }
    html += `<button class="btn-secondary sd-watch" data-watch="${esc(sym)}">${inWatch ? 'Remove from My stocks' : '+ Add to My stocks'}</button>
      <a class="btn-secondary" href="https://finance.yahoo.com/quote/${encodeURIComponent(sym)}" target="_blank" rel="noopener">View on Yahoo Finance</a>
      <p class="disclaimer">Prices may be delayed. The summary is AI-generated from the app’s news coverage and can be wrong. Not financial advice.</p></div>`;

    const page = RR.pushPage({ title: label(sym), backLabel: backLabel || RR.backLabel(), html });
    const box = page.querySelector('.sd-chart-card');
    if (box) {
      drawChart(box, sym, 'd1');
      box.querySelector('.sd-seg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-r]'); if (!b) return;
        box.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('on', x === b));
        drawChart(box, sym, b.dataset.r);
      });
    }
    page.addEventListener('click', (e) => {
      const w = e.target.closest('[data-watch]');
      if (!w) return;
      if (watch.includes(sym)) { removeStock(sym); w.textContent = '+ Add to My stocks'; }
      else { addStock(sym); w.textContent = 'Remove from My stocks'; }
    });
  }
  RR.openStock = openStock;
  RR.renderStocks = () => render();
  // For the desktop layout: your stocks first, then the biggest companies.
  RR.stockStrip = () => {
    if (!data?.quotes) return [];
    const lead = ['^GSPC', '^IXIC', '^DJI', '^FTSE', '^GDAXI', '^N225', '^HSI'];
    return [...new Set([...lead, ...watch, ...(data.top || [])])].map((sym) => {
      const q = quote(sym);
      return q && q.price != null ? { sym, label: label(sym), name: BENCH[sym]?.name || q.shortName || q.name || sym, price: priceOf(sym, q, true), pct: q.changePct } : null;
    }).filter(Boolean);
  };

  // ---------- adding / removing ----------
  let syncTimer = null;
  function scheduleSync() {
    clearTimeout(syncTimer);
    if (!RR.hasLiveKey()) return;
    syncTimer = setTimeout(() => {
      if ($('#stkSheet').open) { scheduleSync(); return; }
      if (RR.isRefreshing()) { scheduleSync(); return; }
      RR.runUpdate('stocks');
    }, 1500);
  }
  function addStock(sym) {
    sym = sym.toUpperCase();
    if (!validSymbol(sym) || watch.includes(sym)) return;
    watch.push(sym); saveWatch(); render();
    toast(RR.hasLiveKey() ? `Added ${sym}. Getting its price, AI summary and headlines (about a minute)…` : `Added ${sym}. Its price arrives with the next update. Turn on Live refresh in Settings to get it straight away.`, 3500);
    if (!quote(sym)) scheduleSync();
    liveAt = 0; tryLive();
  }
  function removeStock(sym) {
    watch = watch.filter((s) => s !== sym); saveWatch(); render();
  }

  // ---------- search sheet ----------
  // Searches a worldwide list of stocks, ETFs, indices, crypto and currencies (data/symbols.json,
  // built from FinanceDatabase on GitHub) by company name or ticker.
  let searchSeq = 0;
  let db = null;          // [{s, n, x, c, t, w}] — symbol, name, exchange label, size rank, type, words
  let dbLoading = null;
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(['inc', 'plc', 'ltd', 'corp', 'corporation', 'co', 'company', 'the', 'sa', 'ag', 'nv', 'se', 'holdings', 'group', 'limited']);
  const TYPE = { E: '', F: 'ETF', I: 'Index', C: 'Crypto', X: '' };

  function entry(s, n, x, c, t, alias) {
    const nn = norm(n);
    const an = alias ? norm(alias) : '';
    return { s, S: s.toUpperCase(), n, x, c, t, nn, an, w: (nn + (an ? ' ' + an : '')).split(' ') };
  }
  function loadDb() {
    if (db || dbLoading) return dbLoading;
    dbLoading = fetch('data/symbols.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const list = [];
      const seen = new Set();
      const alias = new Map(CATALOG);
      // the worldwide list, with friendlier names from our own list as extra search words (e.g. "SpaceX")
      if (j && Array.isArray(j.s)) {
        for (const [sym, name, xi, cap, t] of j.s) {
          if (seen.has(sym)) continue;
          seen.add(sym);
          list.push(entry(sym, name, j.exchanges?.[xi] || '', alias.has(sym) ? Math.max(cap, 4) : cap, t, alias.get(sym)));
        }
      }
      for (const [sym, name] of CATALOG) if (!seen.has(sym)) list.push(entry(sym, name, '', 4, 'E'));
      db = list;
      return db;
    }).catch(() => { db = CATALOG.map(([s, n]) => entry(s, n, '', 4, 'E')); return db; });
    return dbLoading;
  }
  const exchLabel = (sym, x) => x || (sym.endsWith('.L') ? 'London' : sym.startsWith('^') ? 'Index' : /-USD$|-GBP$/.test(sym) ? 'Crypto' : '');

  function score(e, Q, qn, qw) {
    const bare = e.S.split(/[.\-]/)[0];
    let sc = -1;
    if (e.S === Q) sc = 1000;
    else if (bare === Q) sc = 950;
    else if (e.S.startsWith(Q)) sc = 800 - (e.S.length - Q.length) * 5;
    if (qn) {
      if (e.nn === qn || e.an === qn) sc = Math.max(sc, 900);
      else if (e.nn.startsWith(qn) || (e.an && e.an.startsWith(qn))) sc = Math.max(sc, 700);
      else if (qw.every((w) => e.w.some((x) => x.startsWith(w)))) sc = Math.max(sc, 520 + (e.w[0].startsWith(qw[0]) ? 60 : 0));
      else if (qn.length >= 4 && e.nn.includes(qn)) sc = Math.max(sc, 300);
    }
    if (sc < 0) return -1;
    // bigger companies and main US / London listings first
    return sc + e.c * 18 + (e.t === 'E' ? 6 : 0) + (/^(Nasdaq|NYSE|London)$/.test(e.x) ? 8 : 0);
  }
  function results(qs) {
    const q = qs.trim();
    const Q = q.toUpperCase();
    const qn = norm(q);
    const qw = qn.split(' ').filter((w) => w && !STOP.has(w));
    const list = db || CATALOG.map(([s, n]) => entry(s, n, '', 4, 'E'));
    if (!q) return list.filter((e) => !(data?.top || []).includes(e.s)).slice(0, 30);
    const hits = [];
    for (const e of list) {
      const sc = score(e, Q, qn, qw.length ? qw : [qn]);
      if (sc >= 0) hits.push([sc, e]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    const out = hits.slice(0, 50).map((h) => h[1]);
    // Offer the typed text as a ticker only when it looks like one (short, or with . ^ = -).
    if (validSymbol(Q) && (Q.length <= 5 || /[.^=\-]/.test(Q) || /\d/.test(Q)) && !out.some((e) => e.S === Q)) out.push(entry(Q, 'Add this exact ticker', '', 0, 'E'));
    return out;
  }
  function renderResults(list, q) {
    const box = $('#stkResults');
    if (!list.length) {
      box.innerHTML = `<p class="sd-none">Nothing found for “${esc(q)}”. If it’s a private company (like OpenAI or Stripe) it has no shares to follow. Otherwise try the company’s full name or its ticker.</p>`;
      return;
    }
    box.innerHTML = `<div class="list">${list.map((e) => {
      const on = watch.includes(e.s);
      const meta = [exchLabel(e.s, e.x), TYPE[e.t]].filter(Boolean).join(' · ');
      return `<button class="stk-res" data-add="${esc(e.s)}"><div class="stk-id"><b>${esc(e.s)}${meta ? ` <i class="ex">${esc(meta)}</i>` : ''}</b><span>${esc(e.n)}</span></div><span class="add ${on ? 'on' : ''}">${on ? '✓' : '+'}</span></button>`;
    }).join('')}</div>`;
  }
  function runSearch() {
    const q = $('#stkSearch').value;
    renderResults(results(q), q);
    $('#stkResults').scrollTop = 0;
  }
  function openSheet() {
    const sh = $('#stkSheet');
    $('#stkSearch').value = '';
    $('#stkHint').textContent = db ? '' : 'Loading the worldwide stock list…';
    renderResults(results(''), '');
    sh.showModal();
    setTimeout(() => $('#stkSearch').focus(), 250);
    loadDb().then(() => {
      $('#stkHint').textContent = db.length > 500 ? `Search ${db.length.toLocaleString('en-GB')} stocks, funds, indices and currencies by name or ticker` : 'The full stock list arrives with the next update. You can still type any Yahoo Finance ticker.';
      runSearch();
    });
  }

  // ---------- events ----------
  function init() {
    $('#stkAdd').addEventListener('click', openSheet);
    $('#stkEdit').addEventListener('click', () => { editing = !editing; render(); });
    $('#stockList').addEventListener('click', (e) => {
      if (e.target.closest('[data-open-add]')) { openSheet(); return; }
      const del = e.target.closest('[data-del]');
      if (del) { removeStock(del.dataset.del); if (!watch.length) editing = false; render(); return; }
      const row = e.target.closest('[data-stock]');
      if (row && !editing) openStock(row.dataset.stock, 'Stocks');
    });
    $('#stkSearch').addEventListener('input', () => {
      clearTimeout(runSearch._t);
      runSearch._t = setTimeout(runSearch, 90);
    });
    $('#stkResults').addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]'); if (!b) return;
      const sym = b.dataset.add;
      if (watch.includes(sym)) removeStock(sym); else addStock(sym);
      const on = watch.includes(sym);
      const tag = b.querySelector('.add'); tag.classList.toggle('on', on); tag.textContent = on ? '✓' : '+';
    });
    $('#stkSheet').addEventListener('click', (e) => {
      if (e.target === $('#stkSheet') || e.target.closest('[data-close-sheet]')) $('#stkSheet').close();
    });
    $('#stkSheet').addEventListener('close', () => { render(); });

    RR.afterLoad = loadData;
    RR.onTab = (tab) => { if (tab === 'stocks') { loadData().then(tryLive); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData().then(tryLive); });
    setInterval(() => { if (!document.hidden && $('.view[data-view="stocks"]').classList.contains('active')) tryLive(); }, 60e3);
    loadData();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
