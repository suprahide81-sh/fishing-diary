/* ============================================================
   メディア保存（IndexedDB）
   動画・写真などの大きなファイルはここに保存する。
   メタ情報は FD.store.addMedia() で釣行にひも付ける。

   使い方:
     const meta = await FD.media.save(file, { catchId, app:'video' });
     const url  = await FD.media.url(meta.id);   // <video src=url>
============================================================ */
FD.media = (() => {
  const DB_NAME = 'fd-media', STORE = 'blobs';
  let dbp;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('IndexedDB 非対応'));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  }

  const urls = new Map();

  // Blob/File を保存して、釣行にメタ情報を登録する
  async function save(blob, meta = {}, tripId) {
    const kind = meta.kind || (blob.type.startsWith('image/') ? 'image' : 'video');
    const id = FD.util.uid();
    await tx('readwrite', s => s.put(blob, id)); // 本体を先に保存してから一覧に出す
    return FD.store.addMedia(Object.assign({
      id, kind, name: blob.name || `${kind}-${Date.now()}`, type: blob.type, size: blob.size
    }, meta), tripId);
  }
  const get = id => tx('readonly', s => s.get(id));
  async function url(id) {
    if (urls.has(id)) return urls.get(id);
    const b = await get(id); if (!b) return null;
    const u = URL.createObjectURL(b); urls.set(id, u); return u;
  }
  async function remove(id) {
    if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
    try { await tx('readwrite', s => s.delete(id)); } catch (e) { /* 無視 */ }
  }

  return { save, get, url, remove };
})();
