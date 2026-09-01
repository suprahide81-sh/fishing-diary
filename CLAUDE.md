# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Japanese fishing diary web app (釣り日記 / FISHING LOG) — a zero-dependency, single-file mobile PWA. No build system, no package manager. Open `index.html` directly in a browser.

`index.html` is the current main file. `index_8.html` is an extended version (v8) with multi-theme support and a lure database scaffold; it may represent an in-progress iteration.

## Architecture

Both files are fully self-contained: HTML + inline `<style>` + inline `<script>`. There is no external JavaScript, no bundler, no node_modules.

### State (`S` object)

All runtime state lives in a single module-level object:

```js
const S = {
  fields: { spot:[], weather:[], temp:[], wind:[], water:[], lure:[], count:[], size:[], cond:[] },
  fish: [],    // catch log entries
  memos: [],   // field notes
  // index_8.html also: curLure, selSz, selCol
};
```

State is **in-memory only** — it resets on page reload. The exception is the theme preference in `index_8.html`, which is persisted via `localStorage.setItem('fishingTheme', t)`.

### Input dispatch pipeline

All user input (voice or text) flows through one entry point:

```
dispatch(text)
  ├─ size/count regex match → addFish()   → switches to 釣果 tab
  ├─ memo keyword match     → addMemo()   → switches to メモ tab
  └─ everything else        → extractData() → updates fields on データ tab
```

`extractData()` uses regex to parse Japanese natural language into structured fields (spot, weather, temperature, wind, water condition, lure, count, size, comments). Unrecognised text falls into `cond`.

### Speech recognition

Uses `window.SpeechRecognition || window.webkitSpeechRecognition` with `lang = 'ja-JP'`, `continuous = true`, `interimResults = true`. Final transcripts go straight to `dispatch()`; interim results are shown inline. The recognition loop restarts automatically on `onend` while `isRec` is true.

### Theme system (index_8.html only)

Three themes (`light`, `dark`, `wabi`) are implemented as CSS custom property sets on `body.theme-light`, `body.theme-dark`, `body.theme-wabi`. Switching themes only changes the body class and saves to localStorage — no JS color logic elsewhere.

### Lure database (index_8.html)

`const DB = []` is the lure database — currently empty. It's intended to hold objects with `{ name, maker, type, kw[], sizes[], colors[] }`. `matchDB(text)` and `searchDB(q)` are wired up; the suggest UI and lure detail panel exist but are hidden (`display:none!important`) until DB is populated.

### UI tabs

Four tabs map 1-to-1 with `<div class="view">` panels:
- `data` — auto-extracted field tags (データ)
- `fish` — catch log (釣果)
- `memo` — field notes (メモ)
- `sum` — daily summary, rendered on-demand by `renderSum()`

`sw(tabName)` / `switchTab(tabName)` toggles the active tab and scrolls to top.

## Key conventions

- `addU(field, value)` is the only way to write to `S.fields` — it deduplicates and trims.
- Rendered HTML is always rebuilt from state (innerHTML reassignment) rather than patched incrementally.
- `flash(cardId)` adds the `.lit` class for 1.3 s to highlight which card just updated.
- Japanese text matching relies on literal string includes and regex — no NLP library.
- The `norm()` function in `index_8.html` strips common Japanese particles and verb endings before DB lookup.

## Development

No build step. Edit the HTML file and reload the browser.

To test speech recognition, the page must be served over HTTPS or `localhost` (browser security requirement). A minimal local server:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

There are no automated tests or linters in this repository.
