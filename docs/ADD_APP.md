# アプリの組み込み方（動画アプリなど）

釣り日記は「シェル（ヘッダー・下部ナビ）」の上に複数のアプリを載せる作りです。
アプリはどれも同じデータ（釣行・釣果・メモ・動画）を共有します。

## 1. ファイルを作って登録する

`js/apps/myapp.js`

```js
(() => {
  FD.apps.register({
    id: 'myapp',        // 一意なID（URL の #myapp で直接開ける）
    name: '新アプリ',    // 下部ナビの表示名
    icon: '✨',
    order: 30,          // ナビの並び順（日記=10, 動画=20）

    // 最初に開いたとき1回だけ。el にアプリの画面を作る
    mount(el, ctx) {
      el.innerHTML = `<div class="scroll"><div class="sec-hd">新アプリ</div><div data-out></div></div>`;
      const render = () => {
        const t = ctx.store.current();
        el.querySelector('[data-out]').textContent = `${t.date} の釣果 ${t.catches.length}件`;
      };
      const off = ctx.bus.on('store:change', render);
      render();
      return () => off();  // 片付け（任意）
    },

    onShow(ctx, params) {},  // タブを開くたび。ctx.open('myapp', {...}) の params が来る
    onHide(ctx) {}           // 他のタブに移るとき
  });
})();
```

`index.html` のアプリ欄に1行足す（`sw.js` の FILES にも足すとオフラインで使える）:

```html
<script src="js/apps/myapp.js"></script>
```

> 既存の `js/apps/video.js` を作り替えてもOK。`id: 'video'` を残しておけば、
> 釣り日記の釣果カードの 🎬 ボタンから `params.catchId` 付きで開かれます。

## 2. ctx で使えるもの

| 名前 | 内容 |
|---|---|
| `ctx.store` | データ。`current()` 今の釣行 / `trips()` 全釣行 / `addCatch()` `addMemo()` `addField()` / `addMedia()` `updateMedia()` `removeMedia()` / `appData(appId, obj)` アプリ専用の保存領域 / `setting(key, value)` |
| `ctx.media` | 動画・写真の本体。`save(file, meta)` → メタ情報（`id`）/ `url(id)` 再生用URL / `get(id)` Blob / `remove(id)` |
| `ctx.speech` | 音声入力。`start({ onFinal, onInterim })` / `stop()` / `clean(text)` 重複・言いよどみ除去 / `sentence(text)` 句点つきの文章に |
| `ctx.parser` | `parse(text)` → `{ kind:'catch'|'memo'|'data', fields, catch }` |
| `ctx.bus` | アプリ間のイベント。`on(name, fn)` は解除関数を返す |
| `ctx.toast(msg)` / `ctx.confirm(title, body, okLabel)` | 共通UI（confirm は Promise<boolean>） |
| `ctx.open(appId, params)` | 別のアプリを開く |
| `ctx.util` | `esc`（HTMLエスケープ、innerHTML に入れる文字は必ず通す）`hhmm` `dotDate` `uid` `download` など |

## 3. イベント

| イベント | データ | いつ |
|---|---|---|
| `store:change` | `{ trip }` | データが変わるたび |
| `trip:switch` | trip | 釣行を切り替え・新規作成 |
| `catch:added` / `catch:updated` / `catch:removed` | `{ trip, catch }` | 釣果の追加など |
| `memo:added` | `{ trip, memo }` | メモ追加 |
| `media:added` / `media:removed` | `{ trip, media }` | 動画の追加・削除 |
| `speech:state` | true / false | 音声入力の開始・停止 |
| `app:open` | appId | アプリ切り替え |

例：釣果が記録されたら自動で撮影画面を出す、などは `catch:added` を使います。

## 4. データの形

```js
trip = {
  id, date: '2026-10-23',
  fields:  { spot:[], weather:[], temp:[], wind:[], water:[], lure:[], cond:[] },
  catches: [{ id, ts, size, count, species, lure, text }],
  memos:   [{ id, ts, text }],
  media:   [{ id, ts, kind:'video'|'image', name, type, size, duration, catchId, app }]
}
```

動画の本体は IndexedDB、メタ情報は釣行の `media` に入ります。
動画に独自の情報（トリム位置・テロップなど）を持たせたいときは
`ctx.store.updateMedia(id, { trim:[3, 15], caption:'...' })` のように項目を足せばそのまま保存されます。
