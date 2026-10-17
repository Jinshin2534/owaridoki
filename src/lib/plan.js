// いつ蛍の光を流し始め、いつ何を言い、その時点の音量はいくつかを決める。時刻はすべてミリ秒(Date.now() と同じ軸)。

export const START_DB = -30;
export const MINUTE = 60_000;

export const DEFAULT_FAREWELL = 'お時間になりました。本日は、まことにありがとうございました。お忘れ物のないよう、お気をつけてお帰りください。';

// "HH:MM" を、now 以降で最初に来るその時刻にする(過ぎていれば翌日)。
export function nextClockTime(hhmm, nowMs) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(nowMs);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function minutesText(ms) {
  const min = Math.round(ms / MINUTE);
  if (min >= 1) return `${min}分`;
  return `${Math.max(1, Math.round(ms / 1000))}秒`;
}

export function makePlan({ nowMs, endMs, leadMs, announce = true, farewell = DEFAULT_FAREWELL }) {
  const rampStartMs = endMs - leadMs;
  const musicStartMs = Math.max(nowMs, rampStartMs);
  const announcements = [];
  if (announce) {
    const left = endMs - musicStartMs;
    if (left >= 20_000) {
      announcements.push({
        atMs: musicStartMs + 4_000,
        kind: 'start',
        text: `ご歓談中のところ、失礼いたします。まもなく終了のお時間です。終了まで、あと${minutesText(left)}です。お話の区切りのよいところで、まとめに入ってください。`,
      });
    }
    if (left >= 2 * MINUTE) {
      announcements.push({
        atMs: endMs - MINUTE,
        kind: 'oneMinute',
        text: '終了まで、あと1分です。そろそろ、お話をまとめてください。',
      });
    }
    announcements.push({ atMs: endMs, kind: 'end', text: farewell.trim() || DEFAULT_FAREWELL });
  }
  return { endMs, leadMs, rampStartMs, musicStartMs, announcements };
}

// 音量は流し始め(rampStart)の START_DB から、終わる時刻の 0dB まで dB で一直線に上がる。
export function volumeDbAt(plan, tMs) {
  if (tMs >= plan.endMs) return 0;
  if (plan.leadMs <= 0) return 0;
  const p = Math.min(1, Math.max(0, (tMs - plan.rampStartMs) / plan.leadMs));
  return START_DB * (1 - p);
}

export const dbToGain = (db) => 10 ** (db / 20);

export function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
