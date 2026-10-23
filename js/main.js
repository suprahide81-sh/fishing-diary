/* 起動 */
FD.apps.start();

// オフラインでも開けるようにする（https か localhost のときだけ有効）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
