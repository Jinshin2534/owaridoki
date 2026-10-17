// 蛍の光(Auld Lang Syne, スコットランド民謡・パブリックドメイン)をヘ長調・4/4で。
// 拍は1コーラスの頭(弱起の1拍)を0とする。1コーラスは64拍で、最後の小節の4拍目が次のコーラスの弱起になる。

export const BPM = 72;
export const LOOP_BEATS = 64;

const N = { C4: 60, D4: 62, F4: 65, G4: 67, A4: 69, C5: 72, D5: 74, F5: 77 };

// [音, 拍数]。小節ごとに1行。
const TUNE = [
  ['C4', 1],
  ['F4', 1.5], ['F4', 0.5], ['F4', 1], ['A4', 1],
  ['G4', 1.5], ['F4', 0.5], ['G4', 1], ['A4', 1],
  ['F4', 1.5], ['F4', 0.5], ['A4', 1], ['C5', 1],
  ['D5', 3], ['D5', 1],
  ['C5', 1.5], ['A4', 0.5], ['A4', 1], ['F4', 1],
  ['G4', 1.5], ['F4', 0.5], ['G4', 1], ['A4', 1],
  ['F4', 1.5], ['D4', 0.5], ['D4', 1], ['C4', 1],
  ['F4', 3], ['D5', 1],
  ['C5', 1.5], ['A4', 0.5], ['A4', 1], ['F4', 1],
  ['G4', 1.5], ['F4', 0.5], ['G4', 1], ['D5', 1],
  ['C5', 1.5], ['A4', 0.5], ['A4', 1], ['C5', 1],
  ['D5', 3], ['F5', 1],
  ['C5', 1.5], ['A4', 0.5], ['A4', 1], ['F4', 1],
  ['G4', 1.5], ['F4', 0.5], ['G4', 1], ['A4', 1],
  ['F4', 1.5], ['D4', 0.5], ['D4', 1], ['C4', 1],
  ['F4', 3],
];

// 和音: [根音の名前, 拍数]。弱起の1拍は前のコーラスの終わりの響き(F)を続ける。
const CHORD_TONES = {
  F: [53, 57, 60],
  C: [48, 52, 55, 58],
  Bb: [46, 50, 53],
};
const HARMONY = [
  ['F', 1],
  ['F', 4], ['C', 4], ['F', 4], ['Bb', 4],
  ['F', 4], ['C', 4], ['Bb', 2], ['C', 2], ['F', 4],
  ['F', 4], ['C', 4], ['F', 4], ['Bb', 4],
  ['F', 4], ['C', 4], ['Bb', 2], ['C', 2], ['F', 3],
];

function lay(list, toEvent) {
  const out = [];
  let beat = 0;
  for (const [name, beats] of list) {
    out.push({ ...toEvent(name), beat, beats });
    beat += beats;
  }
  return out;
}

export const melody = lay(TUNE, (name) => ({ midi: N[name] }));
export const chords = lay(HARMONY, (name) => ({ name, notes: CHORD_TONES[name], bass: CHORD_TONES[name][0] - 12 }));

export const secondsPerBeat = (bpm = BPM) => 60 / bpm;
export const loopSeconds = (bpm = BPM) => LOOP_BEATS * secondsPerBeat(bpm);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

// 曲の頭(startSec)から数えて、t 秒以降で最初に来るコーラスの終わり(=曲をきれいに終えられる時刻)。
export function nextLoopEnd(startSec, tSec, bpm = BPM) {
  const len = loopSeconds(bpm);
  const n = Math.max(1, Math.ceil((tSec - startSec) / len - 1e-9));
  return startSec + n * len;
}
