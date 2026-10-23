/* ============================================================
   アプリの登録とシェル（ヘッダー・下部ナビ・切り替え）

   新しいアプリは js/apps/ にファイルを作って次のように登録する:

   FD.apps.register({
     id: 'video', name: '動画', icon: '🎬', order: 20,
     mount(el, ctx) {           // 最初に開いたとき1回だけ呼ばれる
       el.innerHTML = '...';
       return () => {};         // 片付け処理（任意）
     },
     onShow(ctx, params) {},    // タブを開くたび（任意）
     onHide(ctx) {}             // 他のタブに移るとき（任意）
   });

   ctx には共通機能が入っている（docs/ADD_APP.md 参照）
============================================================ */
FD.apps = (() => {
  const { esc, dotDate } = FD.util;
  const list = [];
  const mounted = new Map();
  let activeId = null;

  const ctx = {
    store: FD.store, media: FD.media, speech: FD.speech, parser: FD.parser,
    bus: FD.bus, util: FD.util,
    toast: msg => toast(msg),
    confirm: (title, body, okLabel) => confirmDlg(title, body, okLabel),
    open: (id, params) => open(id, params),
    currentApp: () => activeId
  };

  function register(app) {
    if (!app?.id || list.some(a => a.id === app.id)) { console.warn('アプリ登録エラー', app?.id); return; }
    list.push(Object.assign({ order: 100, icon: '📦', name: app.id }, app));
    list.sort((a, b) => a.order - b.order);
    if (document.readyState !== 'loading' && document.getElementById('nav')) renderNav();
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = list.map(a => `
      <button class="nav-btn${a.id === activeId ? ' on' : ''}" data-app="${esc(a.id)}">
        <span class="nav-ico">${a.icon}</span><span class="nav-lbl">${esc(a.name)}</span>
      </button>`).join('');
    nav.style.display = list.length > 1 ? '' : 'none';
  }

  function open(id, params) {
    const app = list.find(a => a.id === id) || list[0];
    if (!app) return;
    if (activeId && activeId !== app.id) {
      const prev = list.find(a => a.id === activeId);
      try { prev?.onHide?.(ctx); } catch (e) { console.error(e); }
      document.getElementById('app-' + activeId)?.classList.remove('on');
    }
    let el = document.getElementById('app-' + app.id);
    if (!el) {
      el = document.createElement('section');
      el.className = 'app'; el.id = 'app-' + app.id;
      document.getElementById('apps').appendChild(el);
    }
    if (!mounted.has(app.id)) {
      try { mounted.set(app.id, app.mount(el, ctx) || null); }
      catch (e) { console.error(e); el.innerHTML = `<div class="empty">⚠️ ${esc(app.name)} の読み込みに失敗しました</div>`; mounted.set(app.id, null); }
    }
    el.classList.add('on');
    activeId = app.id;
    FD.store.setting('lastApp', app.id);
    renderNav();
    try { app.onShow?.(ctx, params); } catch (e) { console.error(e); }
    FD.bus.emit('app:open', app.id);
  }

  // ---------- 共通UI ----------
  let tt;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 2200);
  }
  FD.bus.on('ui:toast', toast);

  function confirmDlg(title, body, okLabel = 'OK') {
    return new Promise(res => {
      const ov = document.getElementById('overlay');
      ov.innerHTML = `<div class="modal" role="dialog">
        <div class="modal-title">${esc(title)}</div>
        <div class="modal-body">${esc(body)}</div>
        <div class="modal-btns"><button class="btn ghost" data-r="0">キャンセル</button><button class="btn danger" data-r="1">${esc(okLabel)}</button></div>
      </div>`;
      ov.classList.add('show');
      ov.onclick = e => {
        const r = e.target.dataset?.r;
        if (r === undefined && e.target !== ov) return;
        ov.classList.remove('show'); ov.onclick = null; res(r === '1');
      };
    });
  }

  // ---------- 釣行の切り替えシート ----------
  function openTripSheet() {
    const cur = FD.store.current();
    const ov = document.getElementById('overlay');
    const rows = FD.store.trips().map(t => {
      const spot = t.fields.spot[0] || '場所未記録';
      const max = t.catches.reduce((m, c) => Math.max(m, c.size || 0), 0);
      const cnt = t.catches.reduce((n, c) => n + (c.count || 1), 0);
      return `<button class="trip-row${t.id === cur.id ? ' on' : ''}" data-id="${t.id}">
        <div class="trip-date">${esc(dotDate(t.date))}</div>
        <div class="trip-sub">${esc(spot)} ・ ${cnt}匹${max ? ` ・ 最大${max}cm` : ''}${t.media.length ? ` ・ 🎬${t.media.length}` : ''}</div>
      </button>`;
    }).join('');
    ov.innerHTML = `<div class="sheet">
      <div class="sheet-hd">釣行を選ぶ</div>
      <div class="sheet-body">${rows}</div>
      <div class="sheet-ft">
        <input type="date" id="newTripDate" value="${FD.util.todayStr()}">
        <button class="btn primary" id="newTripBtn">＋ 新しい釣行</button>
      </div>
    </div>`;
    ov.classList.add('show');
    ov.onclick = e => {
      const row = e.target.closest('.trip-row');
      if (row) { FD.store.selectTrip(row.dataset.id); close(); toast('📅 釣行を切り替えました'); return; }
      if (e.target.id === 'newTripBtn') {
        FD.store.newTrip(document.getElementById('newTripDate').value || FD.util.todayStr());
        close(); toast('🆕 新しい釣行を作りました'); return;
      }
      if (e.target === ov) close();
    };
    function close() { ov.classList.remove('show'); ov.onclick = null; }
  }

  function renderHeader() {
    const t = FD.store.current();
    document.getElementById('tripBtn').innerHTML = `📅 ${esc(dotDate(t.date))} <span class="caret">▾</span>`;
  }

  // ---------- テーマ ----------
  const THEMES = ['light', 'dark', 'wabi'];
  function setTheme(t) {
    if (!THEMES.includes(t)) t = 'light';
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('on', d.dataset.theme === t));
    FD.store.setting('theme', t);
  }

  function start() {
    setTheme(FD.store.setting('theme') || 'light');
    document.querySelectorAll('.theme-dot').forEach(d => d.addEventListener('click', () => setTheme(d.dataset.theme)));
    document.getElementById('tripBtn').addEventListener('click', openTripSheet);
    document.getElementById('nav').addEventListener('click', e => {
      const b = e.target.closest('.nav-btn'); if (b) open(b.dataset.app);
    });
    FD.bus.on('store:change', renderHeader);
    renderHeader();
    renderNav();
    const fromHash = location.hash.slice(1);
    open(list.some(a => a.id === fromHash) ? fromHash : (FD.store.setting('lastApp') || list[0]?.id));
  }

  return { register, open, start, list: () => [...list], ctx, toast };
})();
