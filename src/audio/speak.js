// ブラウザの音声合成で日本語のアナウンスを読む。

const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;

export const speechAvailable = () => !!synth;

export function japaneseVoices() {
  if (!synth) return [];
  return synth.getVoices().filter((v) => /^ja/i.test(v.lang));
}

// 声の一覧はあとから届くことがあるので、届いたら cb を呼ぶ。
export function onVoicesChanged(cb) {
  if (!synth) return;
  synth.addEventListener?.('voiceschanged', cb);
  cb();
}

// 落ち着いた館内放送らしい声を優先する。
export function pickVoice(voiceURI) {
  const list = japaneseVoices();
  if (voiceURI) {
    const v = list.find((x) => x.voiceURI === voiceURI);
    if (v) return v;
  }
  const prefer = [/Kyoko/i, /O-?ren/i, /Google/i, /Nanami/i, /Haruka/i];
  for (const re of prefer) {
    const v = list.find((x) => re.test(x.name));
    if (v) return v;
  }
  return list[0] ?? null;
}

// iOS などでは、最初の読み上げをボタンを押した直後に呼ばないと声が出ない。
export function unlockSpeech() {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
}

export function cancelSpeech() {
  synth?.cancel();
}

// 読み終わったら(または失敗したら)解決する Promise を返す。
export function speak(text, { voiceURI, volume = 1 } = {}) {
  return new Promise((resolve) => {
    if (!synth || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    const v = pickVoice(voiceURI);
    if (v) u.voice = v;
    u.rate = 0.92;
    u.pitch = 1.05;
    u.volume = volume;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    // onend が来ないブラウザがあるので、文字数から長さを見積もって打ち切る
    const guard = setTimeout(finish, 4000 + text.length * 260);
    synth.speak(u);
  });
}
