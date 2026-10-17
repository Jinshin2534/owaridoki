// Web Audio で蛍の光を合成して鳴らす。音量の変化・合図はすべて AudioContext の時計に予約する。
import { BPM, LOOP_BEATS, chords, melody, midiToHz, secondsPerBeat } from '../lib/melody.js';

const LOOKAHEAD = 2.0; // 秒。この先までの音を予約しておく
const TICK_MS = 250;

export class Engine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;

    // music → duck(アナウンス中に下げる) → vol(だんだん大きく) → master(最大音量) → comp → 出力
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 4;
    this.comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.connect(this.comp);
    this.vol = ctx.createGain();
    this.vol.gain.value = 0;
    this.vol.connect(this.master);
    this.duck = ctx.createGain();
    this.duck.connect(this.vol);
    this.music = ctx.createGain();
    this.music.gain.value = 0.5;
    this.music.connect(this.duck);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    this.reverb.connect(wet).connect(this.duck);

    // チャイムは曲の音量とは別に、最大音量だけに従う
    this.chimeBus = ctx.createGain();
    this.chimeBus.gain.value = 0.4;
    this.chimeBus.connect(this.master);
    this.reverbForChime = ctx.createGain();
    this.reverbForChime.gain.value = 0.25;
    this.chimeBus.connect(this.reverbForChime).connect(this.reverb);

    this.silent = ctx.createGain();
    this.silent.gain.value = 0;
    this.silent.connect(ctx.destination);

    this.timer = null;
    this.wakeups = new Set();
    this.song = null; // { start, stopAt, nextLoop, voices:Set }
  }

  now() {
    return this.ctx.currentTime;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setMaster(gain) {
    this.master.gain.setTargetAtTime(gain, this.now(), 0.05);
  }

  // AudioContext の時計で t 秒に cb を呼ぶ。背景のタブでもタイマーより正確に起きる。
  wakeAt(t, cb) {
    const src = this.ctx.createConstantSource();
    src.connect(this.silent);
    src.onended = () => {
      this.wakeups.delete(src);
      cb();
    };
    this.wakeups.add(src);
    src.start();
    src.stop(Math.max(t, this.now() + 0.01));
    return src;
  }

  clearWakeups() {
    for (const src of this.wakeups) {
      src.onended = null;
      try { src.stop(); } catch { /* 止まっている */ }
    }
    this.wakeups.clear();
  }

  // 音量カーブを予約する。fromGain で始まり、toTime に toGain になる(指数=dBで一直線)。
  rampVolume(fromTime, fromGain, toTime, toGain) {
    const g = this.vol.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(Math.max(fromGain, 1e-4), fromTime);
    if (toTime > fromTime) g.exponentialRampToValueAtTime(Math.max(toGain, 1e-4), toTime);
  }

  holdVolume(gain, at = this.now()) {
    const g = this.vol.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(gain, at);
  }

  duckFor(start, end) {
    const g = this.duck.gain;
    g.cancelScheduledValues(start);
    g.setTargetAtTime(0.3, start, 0.25);
    g.setTargetAtTime(1, end, 0.6);
  }

  duckDown(at = this.now()) {
    const g = this.duck.gain;
    g.cancelScheduledValues(at);
    g.setTargetAtTime(0.3, at, 0.25);
  }

  duckUp(at = this.now()) {
    const g = this.duck.gain;
    g.cancelScheduledValues(at);
    g.setTargetAtTime(1, at, 0.6);
  }

  // 曲を start 秒から鳴らし始める(コーラスを繰り返す)。
  startSong(start) {
    this.stopSong(0.05);
    this.song = { start, stopAt: Infinity, nextLoop: 0, voices: new Set() };
    this.duck.gain.cancelScheduledValues(0);
    this.duck.gain.setValueAtTime(1, this.now());
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  // 曲を loopEnd 秒(コーラスの切れ目)で終える。それより後のコーラスは予約しない。
  finishSongAt(loopEnd) {
    if (this.song) this.song.stopAt = loopEnd;
  }

  get songPlaying() {
    return !!this.song;
  }

  stopSong(fade = 1.5) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const song = this.song;
    this.song = null;
    if (!song) return;
    const t = this.now();
    for (const v of song.voices) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, fade / 4);
        v.osc.forEach((o) => o.stop(t + fade + 0.1));
      } catch { /* もう終わった音 */ }
    }
  }

  schedule() {
    const song = this.song;
    if (!song) return;
    const spb = secondsPerBeat(BPM);
    const loopLen = LOOP_BEATS * spb;
    const horizon = this.now() + LOOKAHEAD;
    while (true) {
      const loopStart = song.start + song.nextLoop * loopLen;
      if (loopStart >= horizon || loopStart >= song.stopAt - 1e-6) break;
      const last = loopStart + loopLen >= song.stopAt - 1e-6;
      this.scheduleLoop(loopStart, spb, last);
      song.nextLoop += 1;
    }
    if (song.stopAt !== Infinity && this.now() > song.stopAt + 4) {
      clearInterval(this.timer);
      this.timer = null;
      this.song = null;
    }
  }

  scheduleLoop(t0, spb, last) {
    const now = this.now();
    for (const n of melody) {
      const t = t0 + n.beat * spb;
      if (t < now - 0.05) continue;
      const isFinal = last && n === melody.at(-1);
      this.lead(midiToHz(n.midi), t, n.beats * spb * (isFinal ? 1.6 : 0.92), isFinal);
    }
    for (const c of chords) {
      const t = t0 + c.beat * spb;
      if (t + c.beats * spb < now) continue;
      const isFinal = last && c === chords.at(-1);
      const dur = c.beats * spb * (isFinal ? 2 : 1);
      const start = Math.max(t, now);
      this.pad(c.notes, start, t + dur - start);
      for (let b = 0; b < c.beats; b += 2) {
        const tb = t + b * spb;
        if (tb >= now - 0.05) this.bass(midiToHz(c.bass), tb, Math.min(2, c.beats - b) * spb * (isFinal ? 1.5 : 1));
      }
    }
  }

  voice(oscs, gain, end) {
    const v = { osc: oscs, gain };
    this.song?.voices.add(v);
    oscs[0].onended = () => this.song?.voices.delete(v);
    oscs.forEach((o) => o.stop(end));
  }

  // 旋律: 柔らかいオルガン風。三角波+1オクターブ上の正弦波、ゆるいビブラート。
  lead(hz, t, dur, final) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const a = ctx.createOscillator();
    a.type = 'triangle';
    a.frequency.value = hz;
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.value = hz * 2;
    const bg = ctx.createGain();
    bg.gain.value = 0.18;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(hz * 0.004, t + Math.min(0.5, dur));
    lfo.connect(lfoG).connect(a.frequency);
    a.connect(g);
    b.connect(bg).connect(g);
    g.connect(lp).connect(this.music);
    lp.connect(this.reverb);
    const peak = 0.34;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.035);
    g.gain.setTargetAtTime(peak * 0.7, t + 0.035, 0.25);
    const rel = final ? 1.8 : 0.22;
    g.gain.setTargetAtTime(0, t + dur, rel / 3);
    const end = t + dur + rel + 0.1;
    [a, b, lfo].forEach((o) => o.start(t));
    this.voice([a, b, lfo], g, end);
  }

  // 和音: 少しずらした正弦波を重ねた、やわらかい背景。
  pad(notes, t, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    g.connect(lp).connect(this.music);
    lp.connect(this.reverb);
    const oscs = [];
    for (const m of notes) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = midiToHz(m);
        o.detune.value = detune;
        o.connect(g);
        o.start(t);
        oscs.push(o);
      }
    }
    const level = 0.05;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.25);
    g.gain.setValueAtTime(level, t + Math.max(0.25, dur - 0.05));
    g.gain.setTargetAtTime(0, t + dur - 0.05, 0.25);
    this.voice(oscs, g, t + dur + 1.2);
  }

  bass(hz, t, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz;
    const g = ctx.createGain();
    o.connect(g).connect(this.music);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.26, t + 0.02);
    g.gain.setTargetAtTime(0.12, t + 0.02, 0.4);
    g.gain.setTargetAtTime(0, t + dur * 0.95, 0.12);
    o.start(t);
    this.voice([o], g, t + dur + 0.8);
  }

  // 「ピンポンパンポーン」。up=true で上がり(アナウンスの前)、false で下がり(後)。長さ(秒)を返す。
  chime(t, up = true) {
    const notes = up ? [72, 76, 79, 84] : [84, 79, 76, 72];
    const step = 0.32;
    notes.forEach((m, i) => this.bell(midiToHz(m), t + i * step, i === notes.length - 1 ? 1.6 : 0.9));
    return step * (notes.length - 1) + 1.2;
  }

  bell(hz, t, decay) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(this.chimeBus);
    const parts = [[1, 1], [2, 0.28], [3.01, 0.08]];
    const oscs = parts.map(([mul, amp]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz * mul;
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + decay + 0.2);
      return o;
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    return oscs;
  }

  close() {
    this.stopSong(0.1);
    this.clearWakeups();
    this.ctx.close();
  }
}

// 残響用のインパルス応答(ノイズが指数で減衰するもの)を作る。
function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
  }
  return buf;
}
