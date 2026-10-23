/* ============================================================
   釣り日記アプリ
   話す／打つ → 自動でデータ・釣果・メモに振り分けて記録
============================================================ */
(() => {
  const FIELDS = [
    ['spot', '📍 釣り場', true], ['weather', '🌤 天候'], ['temp', '🌡 気温・水温'],
    ['wind', '💨 風'], ['water', '🌊 水・潮'], ['lure', '🎣 ルアー・仕掛け', true], ['cond', '📊 状況・コメント', true]
  ];
  const TABS = [['data', '📋 データ'], ['fish', '🐟 釣果'], ['memo', '📝 メモ'], ['sum', '📊 まとめ']];

  let el, ctx, tab = 'data';
  const $ = s => el.querySelector(s);

  function mount(root, c) {
    el = root; ctx = c;
    const { esc } = ctx.util;
    el.innerHTML = `
      <div class="subtabs">${TABS.map(([id, l]) => `<button class="subtab" data-tab="${id}">${l}${id === 'fish' || id === 'memo' ? ` <span class="bdg" data-bdg="${id}">0</span>` : ''}</button>`).join('')}</div>
      <div class="scroll">
        <div class="view" data-view="data">
          <div class="sec-hd">自動抽出データ <span class="hint">タグをタップで削除</span></div>
          <div class="grid">${FIELDS.map(([k, l, full]) => `<div class="card${full ? ' full' : ''}" data-card="${k}"><div class="card-lbl">${l}</div><div class="tags" data-field="${k}"></div></div>`).join('')}
            <div class="card"><div class="card-lbl">🐟 釣果</div><div class="big" data-stat="count">0<small>匹</small></div></div>
            <div class="card"><div class="card-lbl">📏 最大サイズ</div><div class="big" data-stat="max">-<small>cm</small></div></div>
          </div>
          <div class="help">
            <b>話し方の例</b>
            「場所は○○ダム、晴れ、気温18度」→ データ<br>
            「42センチのバス、スピナーベイトで釣れた」→ 釣果<br>
            「メモ 風裏のワンドに移動」→ メモ
          </div>
        </div>
        <div class="view" data-view="fish"><div class="sec-hd">釣果ログ</div><div class="list" data-list="fish"></div></div>
        <div class="view" data-view="memo"><div class="sec-hd">現場メモ</div><div class="list" data-list="memo"></div></div>
        <div class="view" data-view="sum"><div data-sum></div></div>
      </div>
      <div class="inputbar">
        <div class="interim" data-interim></div>
        <div class="inp-row">
          <textarea class="inp" rows="1" placeholder="ルアー名・状況などを入力…"></textarea>
          <button class="btn primary send" disabled>決定</button>
        </div>
        <button class="mic"><span class="mic-ico">🎤</span><span class="mic-lbl">タップして音声入力</span></button>
      </div>`;

    // サブタブ
    el.querySelector('.subtabs').addEventListener('click', e => { const b = e.target.closest('.subtab'); if (b) show(b.dataset.tab); });

    // 入力
    const inp = $('.inp'), send = $('.send');
    inp.addEventListener('input', () => {
      inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 96) + 'px';
      send.disabled = !inp.value.trim();
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
    send.addEventListener('click', submit);
    function submit() {
      const t = inp.value.trim(); if (!t) return;
      inp.value = ''; inp.style.height = 'auto'; send.disabled = true;
      handle(t);
    }

    // マイク
    $('.mic').addEventListener('click', () => {
      if (ctx.speech.isActive()) ctx.speech.stop();
      else ctx.speech.start({ onFinal: handle, onInterim: t => { $('[data-interim]').textContent = t; } });
    });
    const offSpeech = ctx.bus.on('speech:state', on => {
      $('.mic').classList.toggle('rec', on);
      $('.mic-lbl').textContent = on ? '録音中… タップで停止' : 'タップして音声入力';
    });

    // タグ削除・釣果/メモ操作（イベント委譲）
    el.addEventListener('click', e => {
      const tag = e.target.closest('.tag[data-i]');
      if (tag) { ctx.store.removeField(tag.parentElement.dataset.field, +tag.dataset.i); return; }
      const act = e.target.closest('[data-act]');
      if (act) action(act.dataset.act, act.dataset.id);
    });

    const offStore = ctx.bus.on('store:change', render);
    show(tab);
    return () => { offSpeech(); offStore(); };
  }

  // ---------- 入力の振り分け ----------
  function handle(raw) {
    const text = ctx.speech.clean(raw);
    const r = ctx.parser.parse(text); if (!r) return;
    const s = ctx.store, t = s.current(), key = ctx.util.normKey(r.text), now = Date.now();

    if (r.kind === 'catch') {
      const last = t.catches[0];
      if (last && ctx.util.normKey(last.text) === key && now - last.ts < 60000) { ctx.toast('🐟 同じ釣果は記録済みです'); return; }
      Object.entries(r.fields).forEach(([k, vs]) => vs.forEach(v => s.addField(k, v)));
      const c = r.catch;
      c.text = ctx.speech.sentence(c.text);
      if (!c.lure) c.lure = t.fields.lure[t.fields.lure.length - 1] || '';
      s.addCatch(c);
      flash(['lure']); show('fish'); ctx.toast(`🐟 釣果を記録！${c.size ? ` ${c.size}cm` : ''}`);
      return;
    }
    if (r.kind === 'memo') {
      r.text = ctx.speech.sentence(r.text);
      const prev = t.memos[0], pk = prev && ctx.util.normKey(prev.text);
      if (pk === key || t.memos.some(m => ctx.util.normKey(m.text) === key && now - m.ts < 180000)) { ctx.toast('📝 同じ内容なので省略しました'); return; }
      // 直前のメモの言い直し・続きなら上書き
      if (pk && key.startsWith(pk) && now - prev.ts < 120000) { s.updateMemo(prev.id, r.text); show('memo'); ctx.toast('📝 メモを更新'); return; }
      s.addMemo(r.text); show('memo'); ctx.toast('📝 メモ追加');
      return;
    }
    const upd = [];
    Object.entries(r.fields).forEach(([k, vs]) => vs.forEach(v => { if (s.addField(k, v)) upd.push(k); }));
    if (upd.length) { flash(upd); show('data'); ctx.toast('✅ データ更新'); }
    else ctx.toast('ℹ️ 記録済みの内容です');
  }

  async function action(act, id) {
    const s = ctx.store, t = s.current();
    if (act === 'del-fish' && await ctx.confirm('釣果を削除', 'この釣果を削除しますか？', '削除')) s.removeCatch(id);
    if (act === 'del-memo') s.removeMemo(id);
    if (act === 'edit-fish') {
      const c = t.catches.find(x => x.id === id); if (!c) return;
      const size = prompt('サイズ（cm）', c.size ?? ''); if (size === null) return;
      const lure = prompt('ルアー・仕掛け', c.lure || ''); if (lure === null) return;
      const species = prompt('魚種', c.species || ''); if (species === null) return;
      s.updateCatch(id, { size: parseFloat(ctx.util.toHalf(size)) || null, lure: lure.trim(), species: species.trim() });
    }
    if (act === 'edit-memo') {
      const m = t.memos.find(x => x.id === id); if (!m) return;
      const v = prompt('メモ', m.text); if (v !== null && v.trim()) s.updateMemo(id, v.trim());
    }
    if (act === 'video') ctx.open('video', { catchId: id });
    if (act === 'export-txt') exportText(t);
    if (act === 'backup') ctx.util.download(`釣り日記_バックアップ_${ctx.util.todayStr()}.json`, new Blob([s.exportAll()], { type: 'application/json' }));
    if (act === 'restore') restore();
    if (act === 'dict-add') {
      const from = $('[data-dict-from]').value.trim(), to = $('[data-dict-to]').value.trim();
      if (!from) return;
      s.setting('speechDict', (s.setting('speechDict') || []).filter(([f]) => f !== from).concat([[from, to]]));
      render(); ctx.toast('🔤 言い換えを登録しました');
    }
    if (act === 'dict-del') { s.setting('speechDict', (s.setting('speechDict') || []).filter((_, i) => i !== +id)); render(); }
    if (act === 'clear' && await ctx.confirm('この釣行をクリア', 'この日のデータ・釣果・メモ・動画がすべて消えます。元に戻せません。', 'クリアする')) { s.clearCurrent(); show('data'); ctx.toast('🗑 クリアしました'); }
    if (act === 'del-trip' && await ctx.confirm('釣行を削除', 'この釣行を履歴から削除します。元に戻せません。', '削除')) { s.deleteTrip(t.id); ctx.toast('🗑 削除しました'); }
  }

  function restore() {
    const f = document.createElement('input');
    f.type = 'file'; f.accept = 'application/json,.json';
    f.onchange = async () => {
      try { const n = ctx.store.importAll(await f.files[0].text()); ctx.toast(`📥 ${n}件の釣行を読み込みました`); }
      catch (e) { ctx.toast('⚠️ 読み込めませんでした: ' + e.message); }
    };
    f.click();
  }

  // ---------- 表示 ----------
  function show(id) {
    tab = id;
    el.querySelectorAll('.subtab').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
    el.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.dataset.view === id));
    $('.scroll').scrollTop = 0;
    render();
  }

  function flash(keys) {
    keys.forEach(k => { const c = el.querySelector(`[data-card="${k}"]`); if (!c) return; c.classList.add('lit'); setTimeout(() => c.classList.remove('lit'), 1300); });
  }

  function render() {
    if (!el) return;
    const { esc, hhmm, dotDate, uniq } = ctx.util;
    const t = ctx.store.current();
    const total = t.catches.reduce((n, c) => n + (c.count || 1), 0);
    const max = t.catches.reduce((m, c) => Math.max(m, c.size || 0), 0);

    el.querySelector('[data-bdg="fish"]').textContent = total;
    el.querySelector('[data-bdg="memo"]').textContent = t.memos.length;

    if (tab === 'data') {
      FIELDS.forEach(([k]) => {
        const arr = t.fields[k];
        el.querySelector(`[data-field="${k}"]`).innerHTML = arr.length
          ? arr.map((v, i) => `<span class="tag${k === 'lure' ? ' alt' : ''}" data-i="${i}">${esc(v)}</span>`).join('')
          : '<span class="tag-empty">---</span>';
      });
      el.querySelector('[data-stat="count"]').innerHTML = `${total}<small>匹</small>`;
      el.querySelector('[data-stat="max"]').innerHTML = `${max || '-'}<small>cm</small>`;
    }

    if (tab === 'fish') {
      const hasVideo = ctx.util && FD.apps.list().some(a => a.id === 'video');
      el.querySelector('[data-list="fish"]').innerHTML = t.catches.length ? t.catches.map(c => {
        const vids = t.media.filter(m => m.catchId === c.id).length;
        return `<div class="item fish">
          <div class="fish-sz">${c.size ?? '?'}<small>cm</small></div>
          <div class="item-main">
            <div class="item-title">${esc(c.lure || 'ルアー不明')}</div>
            <div class="item-meta">${hhmm(c.ts)} ／ ${esc(c.species || '魚種未記録')} ${c.count}匹${vids ? ` ／ 🎬${vids}` : ''}</div>
            <div class="item-note">${esc(c.text)}</div>
          </div>
          <div class="item-acts">
            ${hasVideo ? `<button class="icon-btn" data-act="video" data-id="${c.id}" title="動画">🎬</button>` : ''}
            <button class="icon-btn" data-act="edit-fish" data-id="${c.id}" title="編集">✏️</button>
            <button class="icon-btn" data-act="del-fish" data-id="${c.id}" title="削除">🗑</button>
          </div>
        </div>`;
      }).join('') : `<div class="empty"><span class="empty-ico">🐟</span>まだ釣果がありません<br>「42センチ釣れた！」のように<br>サイズや匹数を話してください</div>`;
    }

    if (tab === 'memo') {
      el.querySelector('[data-list="memo"]').innerHTML = t.memos.length ? t.memos.map(m => `
        <div class="item memo">
          <div class="item-main"><div class="memo-time">▶ ${hhmm(m.ts)}</div><div class="memo-txt">${esc(m.text)}</div></div>
          <div class="item-acts">
            <button class="icon-btn" data-act="edit-memo" data-id="${m.id}">✏️</button>
            <button class="icon-btn" data-act="del-memo" data-id="${m.id}">🗑</button>
          </div>
        </div>`).join('') : `<div class="empty"><span class="empty-ico">📝</span>まだメモがありません<br>「メモ」「移動」などで話し始めると<br>ここに追加されます</div>`;
    }

    if (tab === 'sum') {
      const f = t.fields, j = a => uniq(a).join('、') || '未記録';
      const hit = uniq(t.catches.map(c => c.lure).filter(Boolean));
      const rows = [['釣り場', j(f.spot)], ['天候', j(f.weather)], ['気温・水温', j(f.temp)], ['風', j(f.wind)], ['水・潮', j(f.water)], ['ルアー', j(f.lure)], ['総釣果', total + '匹'], ['最大サイズ', max ? max + 'cm' : '未記録'], ['ヒットルアー', hit.join('、') || '未記録'], ['メモ', t.memos.length + '件'], ['動画', t.media.length + '本']];

      // 全釣行の通算
      const all = ctx.store.trips(), allC = all.flatMap(x => x.catches);
      const allMax = allC.reduce((m, c) => Math.max(m, c.size || 0), 0);
      const lureCnt = {};
      allC.forEach(c => { if (c.lure) lureCnt[c.lure] = (lureCnt[c.lure] || 0) + (c.count || 1); });
      const top = Object.entries(lureCnt).sort((a, b) => b[1] - a[1]).slice(0, 5);

      el.querySelector('[data-sum]').innerHTML = `
        <div class="sum-card"><div class="sum-title">📅 ${esc(dotDate(t.date))} のまとめ</div>
          ${rows.map(([k, v]) => `<div class="sum-row"><span class="sum-key">${k}</span><span class="sum-val">${esc(v)}</span></div>`).join('')}</div>
        ${t.catches.length ? `<div class="sum-card"><div class="sum-title">🐟 釣果詳細</div>${[...t.catches].reverse().map((c, i) => `<div class="sum-row"><span class="sum-key">${i + 1}. ${hhmm(c.ts)}</span><span class="sum-val">${c.size ?? '?'}cm ${esc(c.species)} / ${esc(c.lure || '不明')}</span></div>`).join('')}</div>` : ''}
        <div class="sum-card"><div class="sum-title">🏆 通算記録（${all.length}釣行）</div>
          <div class="sum-row"><span class="sum-key">総釣果</span><span class="sum-val">${allC.reduce((n, c) => n + (c.count || 1), 0)}匹</span></div>
          <div class="sum-row"><span class="sum-key">自己最大</span><span class="sum-val">${allMax ? allMax + 'cm' : '未記録'}</span></div>
          ${top.map(([l, n], i) => `<div class="sum-row"><span class="sum-key">ルアー${i + 1}位</span><span class="sum-val">${esc(l)}（${n}匹）</span></div>`).join('')}
        </div>
        <div class="sum-card"><div class="sum-title">🔤 音声の言い換え辞書</div>
          <div class="dict-note">よく間違って変換される言葉を登録すると、音声入力のときに自動で直します（例: 「スピナーベート」→「スピナーベイト」）</div>
          ${(ctx.store.setting('speechDict') || []).map(([f, to], i) => `<div class="sum-row"><span class="sum-key">${esc(f)}</span><span class="sum-val">→ ${esc(to) || '（削除）'} <button class="icon-btn sm" data-act="dict-del" data-id="${i}">✕</button></span></div>`).join('')}
          <div class="dict-form"><input data-dict-from placeholder="変換された言葉"><span>→</span><input data-dict-to placeholder="正しい言葉"><button class="btn primary sm" data-act="dict-add">追加</button></div>
        </div>
        <div class="btn-col">
          <button class="btn primary" data-act="export-txt">💾 この日をテキストで保存</button>
          <button class="btn ghost" data-act="backup">📤 全データをバックアップ</button>
          <button class="btn ghost" data-act="restore">📥 バックアップから復元</button>
          <button class="btn ghost danger-text" data-act="clear">🗑 この釣行をクリア</button>
          <button class="btn ghost danger-text" data-act="del-trip">❌ この釣行を履歴から削除</button>
        </div>`;
    }
  }

  function exportText(t) {
    const { uniq, hhmm, dotDate } = ctx.util, f = t.fields, j = a => uniq(a).join('、') || '未記録';
    const lines = [
      `【釣り日記 ${dotDate(t.date)}】`, '',
      `▼ 釣り場　: ${j(f.spot)}`, `▼ 天候　　: ${j(f.weather)}`, `▼ 気温水温: ${j(f.temp)}`,
      `▼ 風　　　: ${j(f.wind)}`, `▼ 水・潮　: ${j(f.water)}`, `▼ ルアー　: ${j(f.lure)}`,
      `▼ 総釣果　: ${t.catches.reduce((n, c) => n + (c.count || 1), 0)}匹`, '',
      '▼ 釣果ログ:', ...[...t.catches].reverse().map((c, i) => `  ${i + 1}. ${hhmm(c.ts)} - ${c.size ?? '?'}cm ${c.species} [${c.lure || '不明'}]`), '',
      '▼ 現場メモ:', ...uniq([...t.memos].reverse(), m => m.text).map(m => `  ${hhmm(m.ts)} - ${m.text}`),
      ...(f.cond.length ? ['', '▼ 状況・コメント:', ...uniq(f.cond).map(c => '  ' + c)] : [])
    ];
    ctx.util.download(`釣り日記_${t.date}.txt`, new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    ctx.toast('💾 保存しました');
  }

  FD.apps.register({
    id: 'diary', name: '釣り日記', icon: '🎣', order: 10, mount,
    onShow: () => render(),
    onHide: () => ctx.speech.isActive() && ctx.speech.stop()
  });
})();
