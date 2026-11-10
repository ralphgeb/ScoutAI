// Spoken briefings: each morning, the four section briefings (Tech, Finance, World, Fashion) are
// read by Google Cloud Text-to-Speech in Google's Chirp 3: HD voice Aoede, a little faster than normal, so the app
// can play them. The MP3s go to the Scout service's KV store, with
// an index at /audio.json; everyone shares the same four recordings, so the cost doesn't grow
// with listeners (about 6,000 characters a day per voice, inside Google's free monthly allowance).
//
// Needs the GOOGLE_TTS_KEY secret (an API key restricted to the Text-to-Speech API).

import { publishFile, publishBinary } from './publish.mjs';

const API = 'https://texttospeech.googleapis.com/v1';
const LANG = 'en-GB';
export const VOICES = {
  chirp: { label: 'Chirp 3: HD', pattern: /^en-GB-Chirp3-HD-Aoede$/, fallback: /^en-GB-Chirp3-HD-/ },
};
/** A touch quicker than normal, so the briefing sounds more alive. */
const RATE = 1.05;

/** How each section is named when spoken. */
const SPOKEN = { Tech: 'tech', Finance: 'money and markets', World: 'world', Fashion: 'fashion' };

/** Friendly openings: a different one for each section, changing every day. {s} is the section. */
const OPENERS = {
  Morning: [
    'Good morning! Had your coffee yet? Let me catch you up on the {s} news you missed overnight.',
    'Morning! Grab a coffee and let\'s go through what happened in {s} news while you were asleep.',
    'Rise and shine. Here\'s your {s} catch-up before the day gets going.',
    'Good morning. Still waking up? No problem, I\'ve got the {s} headlines for you.',
    'Hello and good morning! Here\'s everything worth knowing in {s} news today, in a couple of minutes.',
    'Morning! Before your inbox takes over, here\'s what\'s happening in {s} news.',
    'Good morning. Kettle on? Let\'s run through the {s} stories you need today.',
    'Hey, good morning! Here\'s the {s} news you missed overnight, quick and easy.',
    'Morning! Let\'s start the day with a quick look at the {s} news.',
    'Good morning. On your way in? Here\'s your {s} briefing for the commute.',
    'Morning, early bird! Here\'s what\'s been going on in {s} news.',
    'Good morning! Coffee in one hand, {s} news in the other. Here we go.',
    'Hi, good morning. Here\'s a quick {s} roundup to set you up for the day.',
    'Morning! Lots going on in {s} news today. Let me walk you through it.',
  ],
  Evening: [
    'On your way home? Let me catch you up on today\'s {s} news.',
    'Good evening! Here\'s what happened in {s} news while you were busy today.',
    'Evening! Kick back for a couple of minutes, here\'s your {s} catch-up.',
    'Long day? Here\'s the {s} news you might have missed.',
    'Hello, good evening. Let\'s wrap up the day\'s {s} news.',
    'Evening! Before you switch off, here\'s the latest {s} news.',
    'Good evening. Dinner on the go? Here\'s your {s} roundup.',
    'Hey, welcome back. Here\'s how the day went in {s} news.',
    'Evening! Let me fill you in on the {s} stories from today.',
    'Heading home? Here\'s a quick {s} catch-up for the journey.',
    'Good evening! Here\'s everything that mattered in {s} news today.',
    'Evening. Put your feet up, here\'s your {s} wrap-up.',
  ],
};

/** Morning or Evening, from when the briefing was written (London time). */
export function edition(brief) {
  const d = brief.generated ? new Date(brief.generated) : new Date();
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }).format(d));
  return h < 15 ? 'Morning' : 'Evening';
}

/** Today's opening for a section: different for each section, and a new one each day. */
export function opener(sec, brief) {
  const list = OPENERS[edition(brief)];
  const day = Math.floor((brief.generated ? new Date(brief.generated) : new Date()).getTime() / 86400000);
  const n = ['Tech', 'Finance', 'World', 'Fashion'].indexOf(sec);
  return list[(day * 5 + Math.max(0, n) * 3) % list.length].replace('{s}', SPOKEN[sec] || sec.toLowerCase());
}

/** What's read: a friendly opening, the headline, the lead paragraph and each highlight. */
export function script(sec, brief) {
  const lead = String(brief.summary || '').split(/\n\s*\n/)[0]?.trim() || '';
  const items = (brief.highlights?.length ? brief.highlights.map((h) => (h.label ? `${h.label}. ${h.text}` : h.text))
    : (brief.points || []).map((p) => p.text || p.line)).filter(Boolean);
  return [opener(sec, brief), brief.title, lead, ...items].filter(Boolean).join('\n\n').slice(0, 4500);
}

async function pickVoice(key, want) {
  const r = await fetch(`${API}/voices?languageCode=${LANG}&key=${key}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`voices list answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const names = ((await r.json()).voices || []).map((v) => v.name);
  return names.find((n) => want.pattern.test(n)) || names.find((n) => want.fallback.test(n));
}

async function speak(key, voice, text) {
  const r = await fetch(`${API}/text:synthesize?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ input: { text }, voice: { languageCode: LANG, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: RATE } }),
  });
  if (!r.ok) throw new Error(`synthesize (${voice}) answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from((await r.json()).audioContent, 'base64');
}

/** Records the four section briefings in both voices and publishes them. */
export async function makeAudio(briefing, log = console.log) {
  const key = (process.env.GOOGLE_TTS_KEY || '').trim();
  if (!key) { log('Spoken briefings skipped (no GOOGLE_TTS_KEY).'); return null; }
  const sections = briefing.sections || {};
  const index = { generated: new Date().toISOString(), voices: {}, sections: {} };
  for (const [id, want] of Object.entries(VOICES)) {
    const name = await pickVoice(key, want).catch((e) => { log(`Voice ${want.label}: ${e.message}`); return null; });
    if (!name) continue;
    index.voices[id] = { label: want.label, name };
    for (const sec of ['Tech', 'Finance', 'World', 'Fashion']) {
      const brief = sections[sec];
      if (!brief?.title) continue;
      try {
        const mp3 = await speak(key, name, script(sec, brief));
        const file = `audio-${sec}-${id}.mp3`;
        if (await publishBinary(file, mp3, 'audio/mpeg')) {
          const entry = (index.sections[sec] ||= { title: brief.title, briefing: brief.generated || null, files: {} });
          entry.files[id] = { path: `/audio/${sec}-${id}.mp3`, bytes: mp3.length };
        }
      } catch (e) { log(`Spoken ${sec} (${want.label}) skipped: ${e.message}`); }
    }
  }
  const made = Object.values(index.sections).reduce((n, s) => n + Object.keys(s.files).length, 0);
  if (made) await publishFile('audio.json', index);
  log(`Spoken briefings: ${made} recordings (${Object.values(index.voices).map((v) => v.name).join(', ') || 'no voices'}).`);
  return index;
}

/** Chirp 3: HD voices to compare, with Google's description of each (Charon is the current one). */
export const CHIRP_SAMPLES = {
  Charon: 'informative', Puck: 'upbeat', Fenrir: 'excitable', Sadachbia: 'lively', Achird: 'friendly',
  Zephyr: 'bright', Aoede: 'breezy (current)', Laomedeia: 'upbeat', Leda: 'youthful', Autonoe: 'bright',
};

/** Records the start of the Tech briefing in each sample voice (every British Standard and WaveNet
 *  voice, and the Chirp 3: HD voices above), for the /voices page. */
export async function makeSamples(briefing, log = console.log) {
  const key = (process.env.GOOGLE_TTS_KEY || '').trim();
  if (!key) { log('Voice samples skipped (no GOOGLE_TTS_KEY).'); return; }
  const brief = briefing.sections?.Tech;
  if (!brief?.title) { log('Voice samples skipped (no Tech briefing).'); return; }
  const lead = String(brief.summary || '').split(/\n\s*\n/)[0]?.trim() || '';
  const text = [opener('Tech', brief), brief.title, lead].filter(Boolean).join('\n\n').slice(0, 900);
  const r = await fetch(`${API}/voices?languageCode=${LANG}&key=${key}`, { signal: AbortSignal.timeout(20000) });
  const all = r.ok ? ((await r.json()).voices || []) : [];
  const gender = (name) => ({ MALE: 'male', FEMALE: 'female' })[all.find((v) => v.name === name)?.ssmlGender] || '';
  const list = [];
  for (const tier of ['Standard', 'Wavenet']) {
    for (const v of all.filter((v) => new RegExp(`^en-GB-${tier}-[A-Z]$`).test(v.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const letter = v.name.slice(-1);
      const current = false;
      list.push({ tier: tier === 'Wavenet' ? 'WaveNet' : 'Standard', voice: `${tier}-${letter}`, name: v.name, mood: current ? 'current' : '' });
    }
  }
  for (const [voice, mood] of Object.entries(CHIRP_SAMPLES)) list.push({ tier: 'Chirp 3: HD', voice, name: `en-GB-Chirp3-HD-${voice}`, mood });
  const out = { generated: new Date().toISOString(), samples: [] };
  for (const s of list) {
    try {
      const mp3 = await speak(key, s.name, text);
      const g = gender(s.name);
      const mood = [g, s.mood].filter(Boolean).join(', ');
      if (await publishBinary(`audio-sample-${s.voice}.mp3`, mp3, 'audio/mpeg')) out.samples.push({ ...s, mood, path: `/audio/sample-${s.voice}.mp3` });
    } catch (e) { log(`Sample ${s.voice} skipped: ${e.message}`); }
  }
  await publishFile('audio-samples.json', out);
  log(`Voice samples: ${out.samples.length} (${text.length} characters each): ${out.samples.map((s) => s.voice).join(', ')}.`);
}
