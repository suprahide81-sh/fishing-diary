/* ============================================================
   共通ユーティリティ
   すべてのアプリから FD.util.xxx で使える
============================================================ */
window.FD = window.FD || {};

FD.util = (() => {
  const pad = n => String(n).padStart(2, '0');

  // 一意なID（時刻 + 乱数）
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dotDate = s => String(s || '').replace(/-/g, '.');
  const hhmm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // innerHTML に入れる文字列は必ずこれを通す
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 全角英数を半角に、空白を整える
  const toHalf = s => String(s || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ \t　]+/g, ' ').trim();

  // 比較用のキー。空白と句読点を落として表記ゆれを吸収する
  const normKey = s => String(s || '').replace(/[\s　、。，．,.!！?？「」『』]/g, '').toLowerCase();

  // 同じ内容をまとめる
  const uniq = (arr, pick = v => v) => {
    const seen = new Set(), out = [];
    for (const v of arr || []) {
      const k = normKey(pick(v));
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(v);
    }
    return out;
  };

  // 小さなイベントバス。アプリ間の連携に使う
  const createBus = () => {
    const map = new Map();
    return {
      on(ev, fn) { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); return () => map.get(ev)?.delete(fn); },
      emit(ev, data) { (map.get(ev) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
    };
  };

  const download = (name, blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return { pad, uid, todayStr, dotDate, hhmm, esc, toHalf, normKey, uniq, createBus, download };
})();

// アプリ間で共有するイベントバス
FD.bus = FD.util.createBus();
