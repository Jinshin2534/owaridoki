import { describe, expect, it } from 'vitest';
import { LOOP_BEATS, chords, loopSeconds, melody, midiToHz, nextLoopEnd } from '../src/lib/melody.js';
import { MINUTE, START_DB, dbToGain, formatClock, makePlan, nextClockTime, volumeDbAt } from '../src/lib/plan.js';

const total = (list) => list.reduce((s, e) => s + e.beats, 0);

describe('旋律', () => {
  it('旋律も和音も1コーラスがちょうど64拍', () => {
    expect(total(melody)).toBe(LOOP_BEATS);
    expect(total(chords)).toBe(LOOP_BEATS);
  });

  it('弱起のドから始まり、主音のファで終わる', () => {
    expect(melody[0].midi).toBe(60);
    expect(melody.at(-1).midi).toBe(65);
    expect(melody.at(-1).beat + melody.at(-1).beats).toBe(LOOP_BEATS);
  });

  it('弱起のあとは4拍ごとに小節が揃う(各小節の音の長さの合計が4)', () => {
    const bars = new Map();
    for (const n of melody.slice(1)) {
      const bar = Math.floor((n.beat - 1) / 4);
      bars.set(bar, (bars.get(bar) ?? 0) + n.beats);
    }
    expect([...bars.values()].slice(0, -1).every((b) => b === 4)).toBe(true);
    expect(bars.size).toBe(16);
  });

  it('72BPMで1コーラスは約53秒', () => {
    expect(loopSeconds()).toBeCloseTo(53.33, 1);
  });

  it('A4は440Hz', () => {
    expect(midiToHz(69)).toBe(440);
  });

  it('終わりの時刻を過ぎて最初のコーラスの切れ目で終える', () => {
    const len = loopSeconds();
    expect(nextLoopEnd(10, 10)).toBeCloseTo(10 + len);
    expect(nextLoopEnd(10, 10 + len * 1.2)).toBeCloseTo(10 + len * 2);
    expect(nextLoopEnd(10, 10 + len * 2)).toBeCloseTo(10 + len * 2);
  });
});

describe('予定', () => {
  const now = new Date(2026, 9, 18, 14, 0, 0).getTime();

  it('「HH:MM」は過ぎていなければ今日、過ぎていれば明日', () => {
    expect(nextClockTime('15:30', now)).toBe(new Date(2026, 9, 18, 15, 30).getTime());
    expect(nextClockTime('13:00', now)).toBe(new Date(2026, 9, 19, 13, 0).getTime());
    expect(nextClockTime('14:00', now)).toBe(new Date(2026, 9, 19, 14, 0).getTime());
    expect(nextClockTime('25:00', now)).toBeNull();
    expect(nextClockTime('abc', now)).toBeNull();
  });

  it('終わる3分前から流し、流し始め・1分前・終わりにアナウンス', () => {
    const plan = makePlan({ nowMs: now, endMs: now + 30 * MINUTE, leadMs: 3 * MINUTE });
    expect(plan.musicStartMs).toBe(now + 27 * MINUTE);
    expect(plan.announcements.map((a) => a.kind)).toEqual(['start', 'oneMinute', 'end']);
    expect(plan.announcements[0].text).toContain('あと3分');
    expect(plan.announcements[1].atMs).toBe(now + 29 * MINUTE);
    expect(plan.announcements[2].atMs).toBe(now + 30 * MINUTE);
  });

  it('残りが流し始める時間より短ければ、すぐ流し、残り時間を言う', () => {
    const plan = makePlan({ nowMs: now, endMs: now + 90_000, leadMs: 5 * MINUTE });
    expect(plan.musicStartMs).toBe(now);
    expect(plan.announcements.map((a) => a.kind)).toEqual(['start', 'end']);
    expect(plan.announcements[0].text).toContain('あと2分');
  });

  it('アナウンスなしにできる', () => {
    const plan = makePlan({ nowMs: now, endMs: now + 10 * MINUTE, leadMs: 3 * MINUTE, announce: false });
    expect(plan.announcements).toEqual([]);
  });

  it('最後のひとことは書き換えられ、空なら既定の文になる', () => {
    const a = makePlan({ nowMs: now, endMs: now + 10 * MINUTE, leadMs: MINUTE, farewell: 'おしまい!' });
    expect(a.announcements.at(-1).text).toBe('おしまい!');
    const b = makePlan({ nowMs: now, endMs: now + 10 * MINUTE, leadMs: MINUTE, farewell: '  ' });
    expect(b.announcements.at(-1).text).toContain('お時間になりました');
  });

  it('音量は流し始めの -30dB から終わりの 0dB まで dB で一直線', () => {
    const plan = makePlan({ nowMs: now, endMs: now + 10 * MINUTE, leadMs: 4 * MINUTE });
    expect(volumeDbAt(plan, now)).toBe(START_DB);
    expect(volumeDbAt(plan, now + 6 * MINUTE)).toBe(START_DB);
    expect(volumeDbAt(plan, now + 8 * MINUTE)).toBeCloseTo(-15);
    expect(volumeDbAt(plan, now + 10 * MINUTE)).toBe(0);
    expect(volumeDbAt(plan, now + 11 * MINUTE)).toBe(0);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-20)).toBeCloseTo(0.1);
  });

  it('残り時間の表示', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(61_000)).toBe('01:01');
    expect(formatClock(60_500)).toBe('01:01');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});
