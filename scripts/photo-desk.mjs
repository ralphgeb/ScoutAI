// The photo desk: picks the pictures readers see first, and makes sure they are sharp and fresh.
//
// Six slots matter most in the app: the cover of Today (the front page's top story), the story right
// under it, and the four section briefings (Tech, Finance, World, Fashion). For each one the desk
//   • gathers every picture the story's outlets published (feed pictures, and the full-size share
//     picture from the articles themselves), and asks each picture CDN for its large version;
//   • measures each picture (the real width and height, read from the file's first bytes), and keeps
//     only sharp landscape ones (1000 px wide or more; 700 px if nothing better exists);
//   • never repeats a picture this slot showed in an earlier briefing (a story that leads two
//     briefings running gets a new picture), and never puts one picture in two slots.
// Credits follow the picture: a picture from another outlet is credited "Image: <outlet>".

const SHARP = 1000;        // wide enough for a full-width cover on any iPhone (3x)
const ACCEPTABLE = 700;    // used only when nothing sharper exists
const MEMORY = 8;          // pictures remembered per slot
const BAD = /logo|placeholder|default[-_.]|fallback|sprite|icon|avatar|blank|1x1|pixel|og-default|share-default|social-default|wikipedia|wikimedia/i;
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5'
};

// ---------- Larger versions from the picture CDNs ----------

const QUERY_SIZED = /(^|\.)(images\.ft\.com|imageio\.forbes\.com|images\.wsj\.net|washingtonpost\.com|wp\.com|thehill\.com|politico\.com|politico\.eu|i-scmp\.com|axios\.com|sphdigital\.com\.sg|mediacorp\.sg|japantimes\.co\.jp|aljazeera\.com|npr\.org|apnews\.com|reuters\.com)$/;
/** Thumbnail services whose pictures are small copies; used only when nothing else exists. */
const THUMBS = /(^|\.)(bing\.com|bing\.net|gstatic\.com|googleusercontent\.com)$/;

/** The same picture at a larger size, where the address says how big it is. Best guesses first. */
export function largerVersions(url) {
  const out = [];
  const add = (u) => { if (u && u !== url && !out.includes(u)) out.push(u); };
  let u;
  try { u = new URL(url); } catch { return out; }
  const host = u.hostname;
  // BBC: /news/240/… or /ace/standard/320/… → 1024
  if (/ichef\.bbci\.co\.uk$/.test(host)) add(url.replace(/\/(news|ace\/standard|ace\/ws|images\/ic)\/\d{2,4}(x\d+)?\//, (m, p) => `/${p}/1024/`));
  // New York Times: -articleLarge.jpg, -thumbStandard.jpg … → -superJumbo.jpg
  if (/nyt\.com$/.test(host)) add(url.replace(/-(articleLarge|articleInline|thumbStandard|thumbLarge|mediumThreeByTwo\d+|videoSixteenByNine\w*|threeByTwo\w+|square\d+|popup|jumbo|facebookJumbo)\.(jpg|png|webp)/i, '-superJumbo.$2'));
  // WordPress sizes: photo-300x200.jpg → photo.jpg
  add(url.replace(/-\d{2,4}x\d{2,4}(\.(jpe?g|png|webp))(\?|$)/i, '$1$3'));
  // Future plc (TechRadar, Tom's Guide…): name-1200-80.jpg → name.jpg
  if (/futurecdn\.net$/.test(host)) add(url.replace(/-\d{3,4}-\d{2}(\.(jpe?g|png|webp))/i, '$1'));
  // CNN: ?q=w_800,c_fill → w_1600
  if (/cnn\.com$/.test(host)) add(url.replace(/([?&]q=[^&]*?)w_\d+/, '$1w_1600'));
  // Bloomberg: /v1/600x-1.jpg → /v1/-1x-1.jpg (the original)
  if (/bwbx\.io$/.test(host)) add(url.replace(/\/v1\/\d+x-?\d+\./, '/v1/-1x-1.'));
  // Yahoo: resizefill_w400 → w1200
  if (/yimg\.com$/.test(host)) add(url.replace(/(resize(?:fill)?_w)\d+/i, '$11600'));
  // Size in the query: width / w / resize, only on picture services known to send the real larger
  // original (others may blow a small picture up, which measures big but looks blurry), and never
  // on signed addresses (Guardian ?s=…)
  if (QUERY_SIZED.test(host) && !u.searchParams.has('s') && !u.searchParams.has('sig') && !u.searchParams.has('signature')) {
    const v = new URL(url);
    let changed = false;
    for (const k of ['width', 'w', 'imwidth', 'maxwidth', 'size']) {
      if (v.searchParams.has(k) && Number(v.searchParams.get(k)) < 1600) { v.searchParams.set(k, '1600'); changed = true; }
    }
    for (const k of ['height', 'h']) if (v.searchParams.has(k)) { v.searchParams.delete(k); changed = true; }
    if (v.searchParams.has('resize')) { v.searchParams.delete('resize'); changed = true; }
    if (changed) add(v.toString());
    // WSJ and Washington Post pictures take a width
    if (/images\.wsj\.net$/.test(host) && !v.searchParams.has('width')) add(`${url}${url.includes('?') ? '&' : '?'}width=1600`);
  }
  return out;
}

// ---------- Measuring a picture ----------

/** Width and height from a picture file's first bytes (JPEG, PNG, GIF, WebP, AVIF), or null. */
export function imageSize(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  if (b.length < 24) return null;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32(16), h: u32(20), type: 'png' };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(6), h: le16(8), type: 'gif' };
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff, type: 'webp' };
    if (kind === 'VP8L') { const x = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1, type: 'webp' }; }
    if (kind === 'VP8X') return { w: le24(24) + 1, h: le24(27) + 1, type: 'webp' };
    return null;
  }
  // JPEG: walk the markers to the frame header
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = u16(i + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        return { w: u16(i + 7), h: u16(i + 5), type: 'jpeg' };
      }
      i += 2 + len;
    }
    return null;
  }
  // AVIF / HEIF: the 'ispe' box holds the size
  for (let i = 4; i + 16 < b.length && i < 4096; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) return { w: u32(i + 8), h: u32(i + 12), type: 'avif' };
  }
  return null;
}

const measured = new Map();
/** Fetches just enough of a picture to read its size. */
export async function measure(url, ms = 8000) {
  if (measured.has(url)) return measured.get(url);
  const job = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { ...BROWSER, Range: 'bytes=0-262143' } });
      if (!(res.ok || res.status === 206) || !res.body) return null;
      const type = res.headers.get('content-type') || '';
      if (type && !/image|octet-stream/i.test(type)) return null;
      const reader = res.body.getReader();
      const parts = [];
      let n = 0;
      while (n < 262144) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value); n += value.length;
        const size = imageSize(concat(parts, n));
        if (size) { reader.cancel().catch(() => {}); return size; }
      }
      reader.cancel().catch(() => {});
      return imageSize(concat(parts, n));
    } catch { return null; } finally { clearTimeout(t); }
  })();
  measured.set(url, job);
  return job;
}
const concat = (parts, n) => { const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// ---------- Choosing ----------

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** Two addresses that are the same picture in another size count as one. */
export const pictureKey = (u) => {
  try {
    const x = new URL(u);
    return (x.hostname + x.pathname).toLowerCase()
      .replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, '').replace(/-\d{3,4}-\d{2}(?=\.\w+$)/, '')
      .replace(/\/(news|ace\/standard)\/\d+\//, '/$1/')
      .replace(/-(superjumbo|articlelarge|thumbstandard|jumbo|articleinline)(?=\.\w+$)/, '');
  } catch { return u; }
};

/**
 * The sharpest fresh picture for a story: its own, its outlets' feed pictures and the share
 * pictures on their articles, each in its largest version. `avoid` holds picture keys not to use.
 * `readPage(link)` returns { image } from an article page (the updater's own reader).
 */
export async function bestPicture(story, { avoid = new Set(), readPage, pages = 5, more } = {}) {
  const leadName = story.sources?.[0]?.name || '';
  const cands = [];
  const push = (url, credit) => { if (url && /^https?:\/\//.test(url) && !BAD.test(url) && !cands.some((c) => c.url === url)) cands.push({ url, credit }); };
  push(story.image, story.image_credit || '');
  for (const s of story.sources || []) push(s.image, s.name === leadName ? '' : s.name);
  if (readPage) {
    // the share picture (og:image) on the articles themselves is usually the full-size one
    const links = (story.sources || []).filter((s) => s.link && !/news\.google\.com/.test(s.link)).slice(0, pages);
    const found = await Promise.all(links.map(async (s) => { try { return { url: (await readPage(s.link))?.image, credit: s.name === leadName ? '' : s.name }; } catch { return null; } }));
    for (const f of found) if (f) push(f.url, f.credit);
  }
  const pick = await choose(cands, avoid);
  if (pick || !more) return pick;
  // nothing fresh and sharp among the story's own outlets: other outlets covering the same event
  let extra = [];
  try { extra = (await more(story)) || []; } catch { extra = []; }
  return choose(extra.filter((c) => c.url && !BAD.test(c.url) && !cands.some((x) => x.url === c.url)), avoid);
}

async function choose(cands, avoid) {
  const tried = [];
  for (const c of cands) {
    if (avoid.has(pictureKey(c.url))) continue;
    for (const url of [...largerVersions(c.url), c.url]) {
      const size = await measure(url);
      if (!size || !size.w || !size.h) continue;
      tried.push({ ...c, url, w: size.w, h: size.h });
      break;   // the largest version that loads is enough for this picture
    }
  }
  // landscape pictures fit the covers; very tall or very thin ones crop badly
  const fits = (p) => p.w / p.h >= 1.2 && p.w / p.h <= 2.4;
  const score = (p) => Math.min(p.w, 2400) + (fits(p) ? 600 : 0) + (p.credit ? 0 : 150) - (THUMBS.test(hostOf(p.url)) ? 2000 : 0);
  const ranked = tried.sort((a, b) => score(b) - score(a));
  const real = (p) => !THUMBS.test(hostOf(p.url));
  return ranked.find((p) => real(p) && p.w >= SHARP && fits(p)) || ranked.find((p) => real(p) && p.w >= SHARP)
    || ranked.find((p) => p.w >= ACCEPTABLE && fits(p)) || null;
}

/**
 * Pictures for the six slots readers see first. `briefing.photos` remembers what each slot showed
 * in earlier briefings; a slot never shows the same picture in two different briefings.
 */
export async function photoDesk(briefing, stories, { readPage, more, log = () => {} } = {}) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const memory = briefing.photos || (briefing.photos = {});
  const taken = new Set();
  const report = [];
  const ed = briefing.editions?.[0];

  // one slot: which briefing it belongs to, the stories it may show (best first), and where the
  // chosen picture goes
  const slots = [];
  if (ed) {
    const tops = (ed.top_stories || []).map((t) => byId.get(t.story_id)).filter(Boolean);
    if (tops[0]) slots.push({ name: 'cover', brief: ed.id, stories: [tops[0]], set: (p, s) => { setStory(s, p); ed.image = p.url; } });
    if (tops[1]) slots.push({ name: 'second', brief: ed.id, stories: [tops[1]], set: (p, s) => setStory(s, p) });
  }
  for (const sec of ['Tech', 'Finance', 'World', 'Fashion']) {
    const b = briefing.sections?.[sec];
    if (!b) continue;
    const pool = [byId.get(b.lead_story_id), ...(b.points || []).map((x) => byId.get(x.story_id))].filter(Boolean);
    slots.push({ name: sec, brief: `${sec}:${b.generated || ''}`, stories: [...new Set(pool)].slice(0, 5), set: (p) => { b.image = p.url; if (p.credit) b.image_credit = p.credit; else delete b.image_credit; } });
  }

  for (const slot of slots) {
    const past = (memory[slot.name] || []).filter((m) => m.brief !== slot.brief);
    const same = (memory[slot.name] || []).find((m) => m.brief === slot.brief);
    const avoid = new Set([...past.map((m) => m.key), ...taken]);
    // within the same briefing a slot keeps its picture (a later run of the same briefing doesn't
    // reshuffle), unless it was blurry or is now taken by another slot
    if (same && !taken.has(same.key) && same.w >= SHARP) {
      taken.add(same.key);
      report.push(`${slot.name}: kept (${same.w}px)`);
      continue;
    }
    let pick = null, from = null;
    // the slot's stories first from their own outlets, then (lead story only) other outlets
    for (const [i, s] of slot.stories.entries()) {
      pick = await bestPicture(s, { avoid, readPage, pages: i === 0 ? 6 : 3, more: i === 0 ? more : undefined });
      if (pick) { from = s; break; }
    }
    if (!pick) { report.push(`${slot.name}: nothing sharper found`); continue; }
    slot.set(pick, from);
    const key = pictureKey(pick.url);
    taken.add(key);
    memory[slot.name] = [{ brief: slot.brief, story: from.id, key, url: pick.url, w: pick.w }, ...(memory[slot.name] || []).filter((m) => m.brief !== slot.brief)].slice(0, MEMORY);
    report.push(`${slot.name}: ${pick.w}×${pick.h}${pick.credit ? ` (${pick.credit})` : ''}${past.some((m) => m.story === from.id) ? ', new picture for a returning story' : ''}`);
  }
  log(`Photo desk: ${report.join('; ')}.`);
  return report;
}

function setStory(story, p) {
  story.image = p.url;
  if (p.credit) story.image_credit = p.credit; else delete story.image_credit;
  story.image_checked = true;
}
