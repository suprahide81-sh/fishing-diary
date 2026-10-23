/* ============================================================
   データストア（localStorage に自動保存）
   釣行（trip）単位で記録を持ち、全アプリで共有する。

   trip = {
     id, date:'YYYY-MM-DD', createdAt, updatedAt,
     fields: { spot:[], weather:[], temp:[], wind:[], water:[], lure:[], cond:[] },
     catches: [{ id, ts, size, count, species, lure, text }],
     memos:   [{ id, ts, text }],
     media:   [{ id, ts, kind:'video'|'image', name, type, size, duration, catchId, app }]
   }
   ※ 動画などの本体は FD.media（IndexedDB）に保存し、ここにはメタ情報だけ持つ
============================================================ */
FD.store = (() => {
  const KEY = 'fd.v2.data';
  const { uid, todayStr, normKey } = FD.util;
  const FIELD_KEYS = ['spot', 'weather', 'temp', 'wind', 'water', 'lure', 'cond'];
  // 片方がもう一方を含むときにまとめてよいフィールド
  const MERGE_FIELDS = ['spot', 'lure', 'cond', 'water', 'wind'];

  let db = load();

  function blankTrip(date = todayStr()) {
    const now = Date.now();
    return {
      id: uid(), date, createdAt: now, updatedAt: now,
      fields: Object.fromEntries(FIELD_KEYS.map(k => [k, []])),
      catches: [], memos: [], media: []
    };
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && Array.isArray(raw.trips)) {
        raw.trips.forEach(t => {
          t.fields = Object.assign(Object.fromEntries(FIELD_KEYS.map(k => [k, []])), t.fields);
          t.catches ||= []; t.memos ||= []; t.media ||= [];
        });
        raw.settings ||= {};
        raw.appData ||= {};
        return raw;
      }
    } catch (e) { console.warn('load failed', e); }
    return { trips: [], currentId: null, settings: {}, appData: {} };
  }

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(db)); }
      catch (e) { FD.bus.emit('ui:toast', '⚠️ 保存容量が足りません'); }
    }, 150);
  }

  function changed(trip, ev, data) {
    if (trip) trip.updatedAt = Date.now();
    save();
    if (ev) FD.bus.emit(ev, data);
    FD.bus.emit('store:change', { trip });
  }

  // ---------- 釣行 ----------
  function trips() { return [...db.trips].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)); }
  function trip(id) { return db.trips.find(t => t.id === id) || null; }

  // 今の釣行。なければ今日の分を作る
  function current() {
    let t = trip(db.currentId);
    if (!t) {
      t = db.trips.find(x => x.date === todayStr()) || newTrip(todayStr(), true);
      db.currentId = t.id; save();
    }
    return t;
  }
  function newTrip(date = todayStr(), silent) {
    const t = blankTrip(date);
    db.trips.push(t);
    db.currentId = t.id;
    if (!silent) changed(t, 'trip:switch', t);
    return t;
  }
  function selectTrip(id) {
    if (!trip(id)) return;
    db.currentId = id;
    changed(null, 'trip:switch', trip(id));
  }
  function deleteTrip(id) {
    const t = trip(id); if (!t) return;
    t.media.forEach(m => FD.media?.remove(m.id));
    db.trips = db.trips.filter(x => x.id !== id);
    if (db.currentId === id) db.currentId = null;
    changed(null, 'trip:switch', current());
  }
  function setDate(date) { const t = current(); t.date = date; changed(t); }

  // ---------- 抽出データ ----------
  function addField(field, val) {
    if (!FIELD_KEYS.includes(field)) return false;
    val = String(val || '').trim(); if (!val) return false;
    const arr = current().fields[field], key = normKey(val);
    if (!key) return false;
    for (let i = 0; i < arr.length; i++) {
      const k = normKey(arr[i]);
      if (k === key) return false;
      if (MERGE_FIELDS.includes(field) && Math.min(k.length, key.length) >= 3) {
        if (k.includes(key)) return false;                // 既存の方が詳しい
        if (key.includes(k)) { arr[i] = val; changed(current()); return true; } // 新しい方が詳しい
      }
    }
    arr.push(val); changed(current());
    return true;
  }
  function removeField(field, i) { current().fields[field].splice(i, 1); changed(current()); }

  // ---------- 釣果 ----------
  function addCatch(c) {
    const t = current();
    const item = Object.assign({ id: uid(), ts: Date.now(), size: null, count: 1, species: '', lure: '', text: '' }, c);
    t.catches.unshift(item);
    changed(t, 'catch:added', { trip: t, catch: item });
    return item;
  }
  function updateCatch(id, patch) {
    const t = current(), c = t.catches.find(x => x.id === id); if (!c) return;
    Object.assign(c, patch); changed(t, 'catch:updated', { trip: t, catch: c });
  }
  function removeCatch(id) {
    const t = current(); t.catches = t.catches.filter(x => x.id !== id);
    t.media.forEach(m => { if (m.catchId === id) m.catchId = null; });
    changed(t, 'catch:removed', { trip: t, id });
  }

  // ---------- メモ ----------
  function addMemo(text) {
    const t = current(), item = { id: uid(), ts: Date.now(), text };
    t.memos.unshift(item);
    changed(t, 'memo:added', { trip: t, memo: item });
    return item;
  }
  function updateMemo(id, text) { const t = current(), m = t.memos.find(x => x.id === id); if (m) { m.text = text; m.ts = Date.now(); changed(t); } }
  function removeMemo(id) { const t = current(); t.memos = t.memos.filter(x => x.id !== id); changed(t); }

  // ---------- メディア（メタ情報） ----------
  function addMedia(meta, tripId) {
    const t = trip(tripId) || current();
    const item = Object.assign({ id: uid(), ts: Date.now(), kind: 'video', catchId: null, app: '' }, meta);
    t.media.unshift(item);
    changed(t, 'media:added', { trip: t, media: item });
    return item;
  }
  function updateMedia(id, patch) {
    for (const t of db.trips) { const m = t.media.find(x => x.id === id); if (m) { Object.assign(m, patch); changed(t); return; } }
  }
  function removeMedia(id) {
    for (const t of db.trips) {
      if (t.media.some(x => x.id === id)) {
        t.media = t.media.filter(x => x.id !== id);
        FD.media?.remove(id);
        changed(t, 'media:removed', { trip: t, id });
        return;
      }
    }
  }

  // ---------- 設定・アプリ専用データ ----------
  function setting(k, v) { if (v === undefined) return db.settings[k]; db.settings[k] = v; save(); }
  // 各アプリが自由に使える保存領域（appId ごとに分かれる）
  function appData(appId, v) { if (v === undefined) return db.appData[appId] || {}; db.appData[appId] = v; save(); }

  function clearCurrent() {
    const t = current();
    t.media.forEach(m => FD.media?.remove(m.id));
    Object.assign(t, blankTrip(t.date), { id: t.id, createdAt: t.createdAt });
    changed(t, 'trip:switch', t);
  }

  // バックアップ（JSON）
  function exportAll() { return JSON.stringify(db, null, 2); }
  function importAll(json) {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.trips)) throw new Error('形式が違います');
    const have = new Set(db.trips.map(t => t.id));
    data.trips.forEach(t => { if (!have.has(t.id)) db.trips.push(t); });
    localStorage.setItem(KEY, JSON.stringify(db));
    db = load();
    changed(null, 'trip:switch', current());
    return data.trips.length;
  }

  return {
    FIELD_KEYS, trips, trip, current, newTrip, selectTrip, deleteTrip, setDate,
    addField, removeField, addCatch, updateCatch, removeCatch,
    addMemo, updateMemo, removeMemo, addMedia, updateMedia, removeMedia,
    setting, appData, clearCurrent, exportAll, importAll
  };
})();
