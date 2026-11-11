// Spoken briefings: each morning, the four section briefings (Tech, Finance, World, Fashion) are
// read by Google Cloud Text-to-Speech in Google's Chirp 3: HD voice Aoede, a little faster than normal, so the app
// can play them. The MP3s go to the Scout service's KV store, with
// an index at /audio.json; everyone shares the same four recordings, so the cost doesn't grow
// with listeners (about 6,000 characters a day per voice, inside Google's free monthly allowance).
//
// Needs the GOOGLE_TTS_KEY secret (an API key restricted to the Text-to-Speech API).

import { spawn } from 'node:child_process';
import { publishFile, publishBinary, readFile, addStats } from './publish.mjs';

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

/** What's read: the headline, the lead paragraph and each highlight. The friendly opening is
 *  recorded on its own (a few seconds), so the app plays it only before the first briefing of
 *  each edition and the rest start straight with the news. */
export function script(sec, brief) {
  const lead = String(brief.summary || '').split(/\n\s*\n/)[0]?.trim() || '';
  const items = (brief.highlights?.length ? brief.highlights.map((h) => (h.label ? `${h.label}. ${h.text}` : h.text))
    : (brief.points || []).map((p) => p.text || p.line)).filter(Boolean);
  return [brief.title, lead, ...items].filter(Boolean).join('\n\n').slice(0, 4500);
}

async function pickVoice(key, want) {
  const r = await fetch(`${API}/voices?languageCode=${LANG}&key=${key}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`voices list answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const names = ((await r.json()).voices || []).map((v) => v.name);
  return names.find((n) => want.pattern.test(n)) || names.find((n) => want.fallback.test(n));
}

let spoken = 0;   // characters sent to Google this run, for the stats page
let elevenChars = 0;   // characters sent to ElevenLabs this run

// ElevenLabs reads the Tech and World briefings (and their openings) when its key is set; the
// other briefings, the top stories and the hold-on lines stay with Google. If ElevenLabs fails,
// that briefing is recorded with Google instead, so there's always a recording.
//   ELEVENLABS_API_KEY  (secret)  the key from elevenlabs.io › Developers › API keys
//   ELEVENLABS_VOICE_ID (optional) a voice from the Voice Library; default Alice (British, clear)
//   ELEVENLABS_MODEL    (optional) default eleven_multilingual_v2, the most natural
const ELEVEN_SECTIONS = ['Tech', 'World'];
const ELEVEN_VOICE = 'Xb7hH8MSUJpSbSDYk0k2';   // Alice
const ELEVEN_MODEL = 'eleven_multilingual_v2';
/** Per briefing, to compare: World on Flash v2.5 (half the credits), Tech on Multilingual v2. */
const ELEVEN_MODELS = { World: 'eleven_flash_v2_5' };

// Gemini TTS (Google's newer, directable voices) for Finance (Flash) and Fashion (Pro), through the
// Gemini API with a Google AI Studio key (GEMINI_API_KEY). Told how to read, in the same Aoede voice
// as Chirp, so the two can be compared. Gemini sends raw sound, which ffmpeg (on GitHub's runners)
// turns into MP3. If Gemini fails, that briefing is recorded with Chirp 3: HD instead.
const GEMINI = { Finance: 'gemini-2.5-flash-preview-tts', Fashion: 'gemini-2.5-pro-preview-tts' };
const GEMINI_VOICE = 'Callirrhoe';   // easy-going; picked from the /voices samples
const GEMINI_PROMPT = 'Read this as a warm, lively British newsreader presenting a morning news briefing: '
  + 'natural, friendly and clear, at a brisk but relaxed pace, with a light smile in the voice.';
let geminiChars = { flash: 0, pro: 0 };

/** Long scripts go in parts, so each request stays small. */
function chunks(text, max = 3600) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n\n+/)) {
    if (cur && Buffer.byteLength(cur + '\n\n' + para) > max) { out.push(cur); cur = para; }
    else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

/** Raw 24 kHz 16-bit mono sound to MP3, with ffmpeg. */
function toMp3(pcm) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-codec:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.slice(0, 200)}`))));
    ff.stdin.end(pcm);
  });
}

async function speakGemini(_googleKey, model, text, voiceName = GEMINI_VOICE) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('Gemini needs the GEMINI_API_KEY secret (a Google AI Studio key)');
  const plain = text.replace(/\s*\[pause[^\]]*\]\s*/g, ' ... ');
  const pcm = [];
  for (const part of chunks(plain)) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${GEMINI_PROMPT}\n\n${part}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
      }),
    });
    if (!r.ok) {
      // the whole reason (which limit, which project) on one line, so the log says what to fix
      const body = await r.text();
      let why = body;
      try { const e = JSON.parse(body).error; why = [e.message, ...(e.details || []).map((d) => JSON.stringify(d.violations || d.links || d.reason || d))].join(' | '); } catch { /* as sent */ }
      throw new Error(`Gemini (${model}) answered ${r.status}: ${why.replace(/\s+/g, ' ').slice(0, 1200)}`);
    }
    const data = (await r.json()).candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
    if (!data) throw new Error(`Gemini (${model}) sent no sound`);
    pcm.push(Buffer.from(data, 'base64'));
  }
  const mp3 = await toMp3(Buffer.concat(pcm));
  geminiChars[/pro/.test(model) ? 'pro' : 'flash'] += plain.length;
  return mp3;
}

async function speakEleven(text, sec = '') {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  const voice = (process.env.ELEVENLABS_VOICE_ID || '').trim() || ELEVEN_VOICE;
  const model = ELEVEN_MODELS[sec] || (process.env.ELEVENLABS_MODEL || '').trim() || ELEVEN_MODEL;
  const plain = text.replace(/\s*\[pause[^\]]*\]\s*/g, ' ... ');
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: plain, model_id: model,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true, speed: 1.05 } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  elevenChars += plain.length;
  return Buffer.from(await r.arrayBuffer());
}


/** How many stories are recorded ahead each run (in Chirp 3: HD), and how long a story's recording
 *  is kept. Any other story is recorded in WaveNet by the Scout service the first time it's played. */
const TOP_STORIES = 10;
const STORY_DAYS = 10;

/** What a story's recording reads: the headline, Scout's summary and its key points. */
export function storyScript(st) {
  const points = (st.key_points || []).map((k) => (typeof k === 'string' ? k : k?.text || k?.line || '')).filter(Boolean);
  return [st.headline, st.summary || st.claim || '', ...points].filter(Boolean).join('\n\n').slice(0, 4500);
}

/** Short lines the app plays while a story nobody has played yet is being recorded. */
// Two short sentences with a pause between them (Chirp 3: HD's [pause long] markup).
const HOLD = [
  'Okay, getting this story for you now. [pause long] A few more seconds and it\'ll be ready.',
  'One moment, I\'m putting this one together. [pause long] Nearly there.',
  'Right, fetching this story for you. [pause long] Just a couple more seconds.',
  'Hold on, I\'m getting it ready. [pause long] Almost done.',
];
/** Bump when the lines change, so they're recorded again. */
const HOLD_VERSION = 3;

async function speak(key, voice, text) {
  spoken += text.length;
  // lines with [pause] marks go as markup (Chirp 3: HD); if that's refused, as plain text
  const markup = /\[pause/.test(text);
  const send = (input) => fetch(`${API}/text:synthesize?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ input, voice: { languageCode: LANG, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: RATE } }),
  });
  let r = await send(markup ? { markup: text } : { text });
  if (!r.ok && markup) r = await send({ text: text.replace(/\s*\[pause[^\]]*\]\s*/g, ' ... ') });
  if (!r.ok) throw new Error(`synthesize (${voice}) answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from((await r.json()).audioContent, 'base64');
}

/** Records the four section briefings, the day's top stories and the hold-on lines, and publishes them. */
export async function makeAudio(briefing, log = console.log, news = null) {
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
        // Tech and World with ElevenLabs when its key is set (Google if that fails)
        const eleven = id === 'chirp' && ELEVEN_SECTIONS.includes(sec) && (process.env.ELEVENLABS_API_KEY || '').trim();
        const gemini = id === 'chirp' ? GEMINI[sec] : null;
        let engine = 'google';
        const say = async (text) => {
          if (eleven) {
            try { const b = await speakEleven(text, sec); engine = 'elevenlabs'; return b; }
            catch (e) { log(`ElevenLabs (${sec}): ${e.message}; using Google instead.`); }
          }
          if (gemini) {
            try { const b = await speakGemini(key, gemini, text); engine = gemini; return b; }
            catch (e) { log(`${e.message}; using Chirp 3: HD for ${sec} instead.`); }
          }
          return speak(key, name, text);
        };
        const mp3 = await say(script(sec, brief));
        const file = `audio-${sec}-${id}.mp3`;
        if (await publishBinary(file, mp3, 'audio/mpeg')) {
          const entry = (index.sections[sec] ||= { title: brief.title, briefing: brief.generated || null, edition: edition(brief), files: {} });
          entry.files[id] = { path: `/audio/${sec}-${id}.mp3`, bytes: mp3.length, engine };
          // the short friendly opening, in the same voice
          const intro = await say(opener(sec, brief));
          if (await publishBinary(`audio-${sec}-intro.mp3`, intro, 'audio/mpeg')) {
            entry.files.intro = { path: `/audio/${sec}-intro.mp3`, bytes: intro.length, text: opener(sec, brief) };
          }
        }
      } catch (e) { log(`Spoken ${sec} (${want.label}) skipped: ${e.message}`); }
    }
  }
  const made = Object.values(index.sections).reduce((n, s) => n + Object.keys(s.files).filter((f) => f !== 'intro').length, 0);
  const briefingChars = spoken;
  const name = index.voices.chirp?.name;
  const before = (await readFile('audio.json')) || {};

  // the "hold on" lines, recorded once
  index.hold = before.holdVersion === HOLD_VERSION ? before.hold || [] : [];
  index.holdVersion = HOLD_VERSION;
  if (name && index.hold.length < HOLD.length) {
    index.hold = [];
    for (let i = 0; i < HOLD.length; i++) {
      try {
        const mp3 = await speak(key, name, HOLD[i]);
        if (await publishBinary(`audio-hold-${i}.mp3`, mp3, 'audio/mpeg')) index.hold.push(`/audio/hold-${i}.mp3`);
      } catch (e) { log(`Hold-on line ${i} skipped: ${e.message}`); }
    }
  }

  // the day's top stories, recorded ahead so they play straight away (each one once)
  const keep = Date.now() - STORY_DAYS * 86400e3;
  index.stories = Object.fromEntries(Object.entries(before.stories || {}).filter(([, v]) => Date.parse(v.recorded) > keep));
  let storiesMade = 0;
  if (name && news?.stories?.length) {
    const day = Date.now() - 36 * 3600e3;
    const top = news.stories
      .filter((st) => Date.parse(st.first_seen || st.last_updated || 0) > day && st.headline)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.sources?.length || 0) - (a.sources?.length || 0))
      .slice(0, TOP_STORIES);
    for (const st of top) {
      if (index.stories[st.id]) continue;
      try {
        const mp3 = await speak(key, name, storyScript(st));
        if (await publishBinary(`audio-story-${st.id}.mp3`, mp3, 'audio/mpeg', STORY_DAYS)) {
          index.stories[st.id] = { path: `/audio/story/${st.id}.mp3`, recorded: new Date().toISOString(), bytes: mp3.length };
          storiesMade++;
        }
      } catch (e) { log(`Story ${st.id} not recorded: ${e.message}`); }
    }
  }
  if (made || storiesMade) await publishFile('audio.json', index);
  await addStats({ chars_briefings: briefingChars, chars_stories_ahead: spoken - briefingChars, stories_recorded_ahead: storiesMade, briefings_recorded: made, chars_elevenlabs: elevenChars,
    chars_gemini_flash: geminiChars.flash, chars_gemini_pro: geminiChars.pro });
  const byEleven = Object.entries(index.sections).filter(([, v]) => v.files?.chirp?.engine === 'elevenlabs').map(([k]) => k);
  const byGemini = Object.entries(index.sections).filter(([, v]) => /gemini/.test(v.files?.chirp?.engine || '')).map(([k, v]) => `${k} (${v.files.chirp.engine})`);
  log(`Spoken briefings: ${made} recordings (${Object.values(index.voices).map((v) => v.name).join(', ') || 'no voices'}${byEleven.length ? `; ElevenLabs for ${byEleven.join(' and ')}, ${elevenChars} characters` : ''}${byGemini.length ? `; Gemini for ${byGemini.join(', ')}` : ''}); ${storiesMade} top stories recorded ahead; ${spoken} Google characters.`);
  spoken = 0;
  elevenChars = 0;
  geminiChars = { flash: 0, pro: 0 };
  return index;
}

/** Chirp 3: HD voices to compare, with Google's description of each (Charon is the current one). */
export const CHIRP_SAMPLES = {
  Charon: 'informative', Puck: 'upbeat', Fenrir: 'excitable', Sadachbia: 'lively', Achird: 'friendly',
  Zephyr: 'bright', Aoede: 'breezy (current)', Laomedeia: 'upbeat', Leda: 'youthful', Autonoe: 'bright',
};

/** Records the start of the Tech briefing in each sample voice (every British Standard and WaveNet
 *  voice, and the Chirp 3: HD voices above), for the /voices page. */
/** Gemini voices to compare, with Google's description of each (Aoede is the current one). */
export const GEMINI_SAMPLES = {
  Aoede: 'breezy', Sulafat: 'warm', Achernar: 'soft', Vindemiatrix: 'gentle', Despina: 'smooth',
  Callirrhoe: 'easy-going (current)', Laomedeia: 'upbeat', Zephyr: 'bright', Kore: 'firm', Erinome: 'clear',
  Sadaltager: 'knowledgeable', Iapetus: 'clear', Algieba: 'smooth', Achird: 'friendly', Gacrux: 'mature',
};

/** Records the start of the Tech briefing in each Gemini voice (Flash, with the newsreader
 *  direction) and adds them to the /voices page, keeping the other samples there. */
export async function makeGeminiSamples(briefing, log = console.log) {
  const brief = briefing.sections?.Tech;
  if (!brief?.title) { log('Gemini samples skipped (no Tech briefing).'); return; }
  const lead = String(brief.summary || '').split(/\n\s*\n/)[0]?.trim() || '';
  const text = [opener('Tech', brief), brief.title, lead].filter(Boolean).join('\n\n').slice(0, 900);
  const before = (await readFile('audio-samples.json')) || { samples: [] };
  const out = { generated: new Date().toISOString(), samples: (before.samples || []).filter((s) => !String(s.tier).startsWith('Gemini')) };
  let made = 0;
  for (const [voice, mood] of Object.entries(GEMINI_SAMPLES)) {
    try {
      const mp3 = await speakGemini(null, GEMINI.Finance, text, voice);
      const id = `Gem${voice}`;
      if (await publishBinary(`audio-sample-${id}.mp3`, mp3, 'audio/mpeg')) {
        out.samples.push({ tier: 'Gemini 2.5 Flash', voice: id, label: voice, name: voice, mood, path: `/audio/sample-${id}.mp3` });
        made++;
      }
    } catch (e) { log(`Gemini sample ${voice} skipped: ${e.message}`); }
  }
  await publishFile('audio-samples.json', out);
  await addStats({ chars_gemini_flash: geminiChars.flash });
  log(`Gemini samples: ${made} voices (${text.length} characters each, ${geminiChars.flash} in all).`);
  geminiChars = { flash: 0, pro: 0 };
}

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
