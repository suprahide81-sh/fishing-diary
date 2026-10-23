/* ============================================================
   音声入力（Web Speech API）
   どのアプリからでも使える共通サービス。
   端末によって確定結果が何度も届くので、重複をここで取り除く。

   使い方:
     FD.speech.start({ onFinal: text => ..., onInterim: text => ... });
     FD.speech.stop();
============================================================ */
FD.speech = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const { normKey } = FD.util;
  let recog = null, active = false, opts = {};
  let taken = new Map(), lastText = '', lastAt = 0;

  // ---------- 自然な文章に整える ----------
  // 言いよどみ（区切りに挟まれたときだけ消す。「あのポイント」などは残す）
  const FILLER = /(^|[\s、。])(?:えー*っ?と|ええと|えー+|あー+|あのー+|そのー+|うーん|うーむ|んー+|まぁ|まあ)(?=[\s、。！？]|$)[\s、]*/g;
  // よくある誤変換・ひらがな表記 → 正しい表記（辞書はアプリから追加できる）
  const BASE_DICT = [
    ['しーばす', 'シーバス'], ['るあー', 'ルアー'], ['わーむ', 'ワーム'], ['ぽいんと', 'ポイント'],
    ['釣れたー', '釣れた'], ['つれた', '釣れた'], ['つれました', '釣れました']
  ];
  const JP = '[^\\x00-\\x7F]';
  const reJPspace = new RegExp(`(${JP})[ ]+(?=${JP})`, 'g');
  const reNumJP = new RegExp(`(\\d)[ ]+(?=${JP})`, 'g');
  const reJPnum = new RegExp(`(${JP})[ ]+(?=\\d)`, 'g');

  function dict() { return BASE_DICT.concat(FD.store?.setting('speechDict') || []); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // 「晴れです晴れです」のような繰り返しを1つにまとめる
  function collapseRepeats(t) {
    let prev;
    do {
      prev = t;
      t = t.replace(/(\S{1,20}?)(?:[ 、]+\1)+(?=[ 、。！？]|$)/g, '$1'); // 「晴れ 晴れ」「バス、バス」
      t = t.replace(/(.{3,40}?)\1+/g, '$1');                          // 「晴れです晴れです」
      t = t.replace(/(.{2})\1{2,}/g, '$1');                            // 「バスバスバス」（2回は「どんどん」等があるので残す）
    } while (t !== prev);
    return t;
  }
  function dedupeSentences(t) {
    const seen = new Set(), out = []; let buf = '';
    const flush = () => { const k = normKey(buf); if (k && !seen.has(k)) { seen.add(k); out.push(buf); } buf = ''; };
    for (const ch of t) { buf += ch; if ('。！？!?\n'.includes(ch)) flush(); }
    flush();
    return out.join('');
  }
  function clean(raw) {
    if (!raw) return '';
    let t = FD.util.toHalf(raw);
    for (let i = 0; i < 3; i++) t = t.replace(FILLER, '$1'); // 「あー、まあ、」のような連続も消す
    t = collapseRepeats(t);
    t = t.replace(reJPspace, '$1').replace(reNumJP, '$1').replace(reJPnum, '$1'); // 日本語の間の余計な空白
    t = t.replace(/(\d)\s*引き/g, '$1匹');                                       // 「3引き」→「3匹」
    for (const [from, to] of dict()) if (from) t = t.replace(new RegExp(escRe(from), 'g'), to);
    t = collapseRepeats(t);
    t = dedupeSentences(t);
    return t.replace(/[、,]{2,}/g, '、').replace(/。{2,}/g, '。').replace(/^[、。\s]+|[、\s]+$/g, '').trim();
  }
  // 文末に句点をつけて文章らしくする（メモ用）
  function sentence(t) {
    t = clean(t);
    return t && !/[。！？!?」）)]$/.test(t) && /[^\x00-\x7F]/.test(t) ? t + '。' : t;
  }

  // ---------- 確定結果をつなぎ合わせる ----------
  // 端末によっては「42センチ」→「42センチのバス」のように少しずつ伸びた確定結果が別々に届く。
  // 少しだけ待って、続き・重なりを1つの文にまとめてから渡す。
  const WAIT = 900;
  let pend = '', pendTimer = null;
  function overlap(a, b) {
    for (let k = Math.min(a.length, b.length); k >= 2; k--) if (a.endsWith(b.slice(0, k))) return k;
    return 0;
  }
  function queue(raw) {
    const text = clean(raw); if (!text) return;
    if (!pend) pend = text;
    else if (normKey(text).startsWith(normKey(pend))) pend = text;  // 続き・言い直し
    else if (normKey(pend).includes(normKey(text))) { /* もう含まれている */ }
    else {
      const k = overlap(pend, text);
      if (k) pend += text.slice(k);
      else { flush(); pend = text; }
    }
    clearTimeout(pendTimer);
    pendTimer = setTimeout(flush, WAIT);
  }
  function flush() {
    clearTimeout(pendTimer); pendTimer = null;
    const text = clean(pend); pend = '';
    if (!text) return;
    const now = Date.now();
    if (now - lastAt < 8000 && normKey(lastText).includes(normKey(text))) return; // 同じ確定文の再送は捨てる
    lastText = text; lastAt = now;
    opts.onFinal?.(text);
  }

  function start(o = {}) {
    if (!SR) { FD.bus.emit('ui:toast', '⚠️ このブラウザは音声入力に対応していません'); return false; }
    if (active) stop();
    opts = o; active = true; taken = new Map();
    recog = new SR();
    recog.lang = o.lang || 'ja-JP'; recog.continuous = true; recog.interimResults = true;
    recog.onresult = e => {
      let interim = '', fin = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i], t = r[0]?.transcript || '';
        if (!r.isFinal) { interim += t; continue; }
        const prev = taken.get(i) || '';
        if (t === prev) continue;
        taken.set(i, t);
        fin += (prev && t.startsWith(prev)) ? t.slice(prev.length) : t;
      }
      opts.onInterim?.(clean(interim));
      if (fin.trim()) { opts.onInterim?.(''); queue(fin); }
    };
    recog.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      stop(); FD.bus.emit('ui:toast', '⚠️ マイクエラー: ' + e.error);
    };
    // 無音で止まっても、録音中なら自動で再開する
    recog.onend = () => { if (active) { taken = new Map(); try { recog.start(); } catch (e) { /* 無視 */ } } };
    try { recog.start(); } catch (e) { active = false; FD.bus.emit('ui:toast', '⚠️ マイクにアクセスできません'); return false; }
    FD.bus.emit('speech:state', true);
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    flush(); lastText = ''; lastAt = 0;
    try { recog?.stop(); } catch (e) { /* 無視 */ }
    opts.onInterim?.('');
    opts.onEnd?.();
    FD.bus.emit('speech:state', false);
  }

  return { supported: !!SR, start, stop, clean, sentence, isActive: () => active };
})();
