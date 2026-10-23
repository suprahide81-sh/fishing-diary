/* ============================================================
   動画アプリ（土台）
   今は「撮影・取り込み → 釣行／釣果にひも付けて保存 → 再生」まで。
   これから作る動画機能（編集・テロップ・書き出しなど）はここを
   作り替えるか、別ファイルで新しいアプリとして登録する。
   → docs/ADD_APP.md
============================================================ */
(() => {
  let el, ctx, target = null; // target: ひも付ける釣果ID
  const $ = s => el.querySelector(s);

  function mount(root, c) {
    el = root; ctx = c;
    el.innerHTML = `
      <div class="scroll">
        <div class="sec-hd">🎬 動画</div>
        <div class="card full target" data-target></div>
        <div class="btn-row">
          <label class="btn primary">📹 撮影する<input type="file" accept="video/*" capture="environment" hidden data-pick></label>
          <label class="btn ghost">🖼 端末から選ぶ<input type="file" accept="video/*,image/*" multiple hidden data-pick></label>
        </div>
        <div class="list" data-list></div>
      </div>`;

    el.querySelectorAll('[data-pick]').forEach(i => i.addEventListener('change', async () => {
      const files = [...i.files]; i.value = '';
      for (const f of files) await add(f);
    }));

    el.addEventListener('click', e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const { act, id } = a.dataset;
      if (act === 'untarget') { target = null; render(); }
      if (act === 'del') ctx.confirm('動画を削除', 'この動画を削除しますか？', '削除').then(ok => ok && ctx.store.removeMedia(id));
      if (act === 'save') save(id);
      if (act === 'link') link(id);
    });

    // 釣果が記録されたら、その釣果を撮影対象にする
    const off1 = ctx.bus.on('catch:added', ({ catch: c }) => { target = c.id; render(); });
    const off2 = ctx.bus.on('store:change', render);
    const off3 = ctx.bus.on('trip:switch', () => { target = null; render(); });
    return () => { off1(); off2(); off3(); };
  }

  async function add(file) {
    try {
      ctx.toast('⏳ 保存中…');
      const meta = await ctx.media.save(file, { catchId: target, app: 'video' });
      if (meta.kind === 'video') {
        const v = document.createElement('video');
        v.preload = 'metadata'; v.src = await ctx.media.url(meta.id);
        v.onloadedmetadata = () => isFinite(v.duration) && ctx.store.updateMedia(meta.id, { duration: Math.round(v.duration) });
      }
      ctx.toast('🎬 保存しました');
    } catch (e) { ctx.toast('⚠️ 保存できませんでした: ' + e.message); }
  }

  async function save(id) {
    const t = ctx.store.current(), m = t.media.find(x => x.id === id);
    const b = await ctx.media.get(id);
    if (b) ctx.util.download(m?.name || `fishing-${id}`, b);
  }

  function link(id) {
    const t = ctx.store.current();
    const opts = t.catches.map((c, i) => `${i + 1}: ${ctx.util.hhmm(c.ts)} ${c.size ?? '?'}cm ${c.lure || ''}`).join('\n');
    const v = prompt(`どの釣果にひも付けますか？（番号／0で解除）\n${opts}`, '0');
    if (v === null) return;
    const c = t.catches[parseInt(v, 10) - 1];
    ctx.store.updateMedia(id, { catchId: c ? c.id : null });
  }

  const fmtDur = s => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
  const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : Math.round(b / 1e3) + 'KB';

  function render() {
    if (!el || !el.classList.contains('on')) return;
    const { esc, hhmm } = ctx.util, t = ctx.store.current();
    const c = t.catches.find(x => x.id === target);
    if (target && !c) target = null;
    $('[data-target]').innerHTML = c
      ? `<div class="card-lbl">ひも付け先の釣果</div><div class="target-row"><b>${c.size ?? '?'}cm ${esc(c.species)}</b> ${esc(c.lure)}（${hhmm(c.ts)}）<button class="icon-btn sm" data-act="untarget">✕</button></div>`
      : `<div class="card-lbl">ひも付け先</div><div class="target-row">この日の釣行（釣果の🎬ボタンから選ぶと釣果にひも付きます）</div>`;

    const list = $('[data-list]');
    if (!t.media.length) {
      list.innerHTML = `<div class="empty"><span class="empty-ico">🎬</span>まだ動画がありません<br>ファイトやリリースの様子を撮って<br>釣果と一緒に残しましょう</div>`;
      return;
    }
    list.innerHTML = t.media.map(m => {
      const mc = t.catches.find(x => x.id === m.catchId);
      return `<div class="item media">
        <div class="media-view" data-media="${m.id}"></div>
        <div class="item-main">
          <div class="item-title">${mc ? `🐟 ${mc.size ?? '?'}cm ${esc(mc.lure)}` : '釣行の動画'}</div>
          <div class="item-meta">${hhmm(m.ts)} ／ ${fmtDur(m.duration)} ${fmtSize(m.size || 0)}</div>
        </div>
        <div class="item-acts">
          <button class="icon-btn" data-act="link" data-id="${m.id}" title="ひも付け">🔗</button>
          <button class="icon-btn" data-act="save" data-id="${m.id}" title="保存">💾</button>
          <button class="icon-btn" data-act="del" data-id="${m.id}" title="削除">🗑</button>
        </div>
      </div>`;
    }).join('');
    // 本体は IndexedDB から非同期で読み込む
    list.querySelectorAll('[data-media]').forEach(async box => {
      const m = t.media.find(x => x.id === box.dataset.media);
      const url = await ctx.media.url(m.id);
      if (!url) { box.innerHTML = '<div class="media-missing">ファイルなし</div>'; return; }
      box.innerHTML = m.kind === 'image' ? `<img src="${url}" alt="">` : `<video src="${url}" controls playsinline preload="metadata"></video>`;
    });
  }

  FD.apps.register({
    id: 'video', name: '動画', icon: '🎬', order: 20, mount,
    onShow(c, params) { if (params?.catchId) target = params.catchId; render(); }
  });
})();
