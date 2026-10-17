import { Engine } from './audio/engine.js';
import { cancelSpeech, japaneseVoices, onVoicesChanged, speak, speechAvailable, unlockSpeech } from './audio/speak.js';
import { nextLoopEnd } from './lib/melody.js';
import {
  DEFAULT_FAREWELL, MINUTE, START_DB, dbToGain, formatClock, formatHHMM, makePlan, nextClockTime, volumeDbAt,
} from './lib/plan.js';

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'owaridoki:settings';

// ---- 設定 ----
const defaults = {
  mode: 'minutes',
  minutes: 30,
  clock: '',
  lead: 3,
  maxVol: 0.85,
  announce: true,
  voiceURI: '',
  farewell: DEFAULT_FAREWELL,
};

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch { /* 保存できなくても動く */ }
}

const settings = loadSettings();

const ui = {
  setup: $('#setup'),
  run: $('#run'),
  done: $('#done'),
  minutes: $('#minutes'),
  clock: $('#clock'),
  lead: $('#lead'),
  maxVol: $('#maxvol'),
  announce: $('#announce'),
  announceOpts: $('#announce-opts'),
  voice: $('#voice'),
  noVoice: $('#no-voice'),
  farewell: $('#farewell'),
  start: $('#start'),
  preview: $('#preview'),
  phase: $('#phase'),
  remain: $('#remain'),
  endat: $('#endat'),
  meter: $('#meter-fill'),
  volnote: $('#volnote'),
};

function roundedClock(ms) {
  const d = new Date(ms);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return formatHHMM(d.getTime());
}

function renderSettings() {
  for (const b of document.querySelectorAll('.seg-btn')) b.setAttribute('aria-selected', String(b.dataset.mode === settings.mode));
  for (const w of document.querySelectorAll('.when')) w.hidden = w.dataset.for !== settings.mode;
  ui.minutes.value = settings.minutes;
  ui.clock.value = settings.clock || roundedClock(Date.now() + 30 * MINUTE);
  ui.lead.value = String(settings.lead);
  ui.maxVol.value = String(settings.maxVol);
  ui.announce.checked = settings.announce;
  ui.announceOpts.hidden = !settings.announce;
  ui.farewell.value = settings.farewell;
}

function renderVoices() {
  const voices = japaneseVoices();
  ui.noVoice.hidden = speechAvailable() && voices.length > 0;
  ui.voice.innerHTML = '';
  const auto = new Option('おまかせ', '');
  ui.voice.add(auto);
  for (const v of voices) ui.voice.add(new Option(v.name, v.voiceURI));
  ui.voice.value = voices.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
}

document.querySelectorAll('.seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    settings.mode = b.dataset.mode;
    saveSettings();
    renderSettings();
  }),
);
document.querySelectorAll('.quick button').forEach((b) =>
  b.addEventListener('click', () => {
    settings.mode = 'minutes';
    settings.minutes = Number(b.dataset.min);
    saveSettings();
    renderSettings();
  }),
);
ui.minutes.addEventListener('change', () => {
  settings.minutes = Math.min(600, Math.max(1, Math.round(Number(ui.minutes.value) || 30)));
  ui.minutes.value = settings.minutes;
  saveSettings();
});
ui.clock.addEventListener('change', () => {
  settings.clock = ui.clock.value;
  saveSettings();
});
ui.lead.addEventListener('change', () => {
  settings.lead = Number(ui.lead.value);
  saveSettings();
});
ui.maxVol.addEventListener('input', () => {
  settings.maxVol = Number(ui.maxVol.value);
  engine?.setMaster(settings.maxVol);
  saveSettings();
});
ui.announce.addEventListener('change', () => {
  settings.announce = ui.announce.checked;
  ui.announceOpts.hidden = !settings.announce;
  saveSettings();
});
ui.voice.addEventListener('change', () => {
  settings.voiceURI = ui.voice.value;
  saveSettings();
});
ui.farewell.addEventListener('input', () => {
  settings.farewell = ui.farewell.value;
  saveSettings();
});

// ---- 音と予定 ----
let engine = null;
let plan = null;
let songStart = null; // 曲の頭(AudioContext の秒)
let state = 'setup'; // setup | running | ending | done
let ticker = null;
let previewing = false;

async function ensureEngine() {
  if (!engine) engine = new Engine();
  await engine.resume();
  engine.setMaster(settings.maxVol);
  return engine;
}

const toAudio = (ms) => engine.now() + (ms - Date.now()) / 1000;

function endTimeFromSettings(nowMs) {
  if (settings.mode === 'clock') return nextClockTime(ui.clock.value, nowMs);
  return nowMs + settings.minutes * MINUTE;
}

async function start() {
  const nowMs = Date.now();
  const endMs = endTimeFromSettings(nowMs);
  if (!endMs) {
    ui.clock.focus();
    return;
  }
  await ensureEngine();
  unlockSpeech();
  await keepAwake();
  state = 'running';
  show('run');
  schedulePlan(endMs);
  ticker = setInterval(render, 200);
  render();
}

// endMs に向けて予定を立てる(延長のときも呼ぶ)。
function schedulePlan(endMs, extendedBy = 0) {
  const nowMs = Date.now();
  engine.clearWakeups();
  cancelSpeech();
  plan = makePlan({
    nowMs,
    endMs,
    leadMs: settings.lead * MINUTE,
    announce: settings.announce,
    farewell: settings.farewell,
  });

  const keepSong = engine.songPlaying && plan.musicStartMs <= nowMs;
  if (keepSong) {
    // 流れている曲は止めず、今の音量から新しい終わりに向けて上げ直す
    engine.finishSongAt(Infinity);
    engine.rampVolume(engine.now(), engine.vol.gain.value, toAudio(endMs), 1);
    // 流し始めのアナウンスは済んでいるので、延長のお知らせだけにする
    if (extendedBy) plan.announcements = plan.announcements.filter((a) => a.kind !== 'start');
  } else {
    const restarting = engine.songPlaying;
    if (restarting) engine.stopSong(1.5);
    const startAt = Math.max(toAudio(plan.musicStartMs), engine.now() + (restarting ? 1.8 : 0.15));
    const startMs = Date.now() + (startAt - engine.now()) * 1000;
    engine.rampVolume(startAt, dbToGain(volumeDbAt(plan, startMs)), toAudio(endMs), 1);
    engine.wakeAt(startAt - 0.6, () => {
      songStart = startAt;
      engine.startSong(startAt);
    });
  }

  if (extendedBy && settings.announce) {
    const left = Math.round((endMs - nowMs) / MINUTE);
    plan.announcements.unshift({
      atMs: nowMs + 300,
      kind: 'extend',
      text: `終了時刻を、${extendedBy}分延長しました。終了まで、あと${left}分です。`,
    });
  }
  for (const a of plan.announcements) engine.wakeAt(toAudio(a.atMs), () => announce(a));
  engine.wakeAt(toAudio(endMs), onEndTime);
}

async function announce(a) {
  if (state === 'setup' || state === 'done') return;
  const t = engine.now();
  engine.duckDown(t);
  const chimeLen = engine.chime(t + 0.25, true);
  await wait(chimeLen * 1000);
  await speak(a.text, { voiceURI: settings.voiceURI });
  if (a.kind !== 'end' && state !== 'setup') engine.duckUp();
  if (a.kind === 'end') {
    engine.chime(engine.now() + 0.2, false);
    await wait(1800);
    if (state === 'ending') engine.duckUp();
  }
}

function onEndTime() {
  if (state !== 'running') return;
  state = 'ending';
  engine.holdVolume(1);
  // アナウンスが終わるのを待てるよう、少なくとも12秒後以降のコーラスの切れ目で曲を終える
  const finish = songStart != null && engine.songPlaying ? nextLoopEnd(songStart, engine.now() + 12) : engine.now() + 8;
  engine.finishSongAt(finish);
  engine.wakeAt(finish + 3.5, finishAll);
  render();
}

function finishAll() {
  if (state !== 'ending') return;
  state = 'done';
  clearInterval(ticker);
  releaseWake();
  show('done');
  setFlies(1, false);
}

function stopAll() {
  state = 'setup';
  clearInterval(ticker);
  cancelSpeech();
  if (engine) {
    engine.clearWakeups();
    engine.stopSong(1.2);
    engine.duckUp();
  }
  songStart = null;
  plan = null;
  releaseWake();
  show('setup');
  setFlies(0, false);
}

function extend(min) {
  if (state !== 'running' || !plan) return;
  schedulePlan(plan.endMs + min * MINUTE, min);
  render();
}

// ---- 試聴 ----
async function preview() {
  if (previewing || state !== 'setup') return;
  previewing = true;
  ui.preview.disabled = true;
  ui.start.disabled = true;
  await ensureEngine();
  unlockSpeech();
  const t = engine.now() + 0.15;
  engine.holdVolume(dbToGain(-8), t);
  engine.startSong(t);
  if (settings.announce) {
    setTimeout(async () => {
      if (!previewing) return;
      engine.duckDown();
      const len = engine.chime(engine.now() + 0.2, true);
      await wait(len * 1000);
      await speak('これは、試しの再生です。音量と声を確かめてください。', { voiceURI: settings.voiceURI });
      engine.duckUp();
    }, 3500);
  }
  setTimeout(() => {
    cancelSpeech();
    engine.stopSong(2.5);
    previewing = false;
    ui.preview.disabled = false;
    ui.start.disabled = false;
  }, 15000);
}

// ---- 画面 ----
function show(name) {
  ui.setup.hidden = name !== 'setup';
  ui.run.hidden = name !== 'run';
  ui.done.hidden = name !== 'done';
  document.querySelectorAll('[data-extend]').forEach((b) => (b.disabled = false));
}

function render() {
  if (!plan) return;
  const nowMs = Date.now();
  const left = plan.endMs - nowMs;
  const db = volumeDbAt(plan, nowMs);
  const music = nowMs >= plan.musicStartMs;
  const p = music ? 1 - db / START_DB : 0;

  if (state === 'ending') {
    ui.phase.textContent = 'お時間です';
    ui.remain.textContent = '00:00';
    ui.volnote.textContent = 'このコーラスの終わりで曲が終わります';
    document.querySelectorAll('[data-extend]').forEach((b) => (b.disabled = true));
  } else {
    ui.phase.textContent = music ? '蛍の光が流れています' : `蛍の光まで あと ${formatClock(plan.musicStartMs - nowMs)}`;
    ui.remain.textContent = formatClock(left);
    ui.volnote.textContent = music ? `音量 ${Math.round(p * 100)}%(終わる時刻に最大)` : '';
  }
  ui.endat.textContent = `${formatHHMM(plan.endMs)} に終わります`;
  ui.meter.style.width = `${(state === 'ending' ? 1 : p) * 100}%`;
  const near = Math.min(1, Math.max(0, 1 - left / (plan.leadMs * 2)));
  setFlies(state === 'ending' ? 1 : near, true);
  document.title = state === 'ending' ? 'お時間です — おわりどき' : `${formatClock(left)} — おわりどき`;
}

// 蛍の数と明るさを、終わりの近さに合わせる
const flies = [];
function makeFlies() {
  const box = document.querySelector('.fireflies');
  for (let i = 0; i < 26; i++) {
    const f = document.createElement('i');
    f.className = 'fly';
    f.style.left = `${Math.random() * 100}%`;
    f.style.top = `${30 + Math.random() * 70}%`;
    f.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    f.style.setProperty('--dy', `${(Math.random() - 0.5) * 120}px`);
    f.style.setProperty('--dur', `${6 + Math.random() * 8}s`);
    f.style.setProperty('--blink', `${2.5 + Math.random() * 3}s`);
    f.style.setProperty('--delay', `${-Math.random() * 8}s`);
    box.append(f);
    flies.push(f);
  }
}

function setFlies(p, running) {
  document.documentElement.style.setProperty('--p', p.toFixed(3));
  const n = running ? Math.round(4 + p * (flies.length - 4)) : 5;
  flies.forEach((f, i) => f.classList.toggle('on', i < n));
}

// ---- 画面を消さない ----
let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* 使えない環境では何もしない */ }
}
function releaseWake() {
  wakeLock?.release?.();
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state === 'running' || state === 'ending')) keepAwake();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

ui.start.addEventListener('click', start);
ui.preview.addEventListener('click', preview);
$('#stop').addEventListener('click', stopAll);
$('#again').addEventListener('click', stopAll);
document.querySelectorAll('[data-extend]').forEach((b) => b.addEventListener('click', () => extend(Number(b.dataset.extend))));

makeFlies();
renderSettings();
onVoicesChanged(renderVoices);
setFlies(0, false);
