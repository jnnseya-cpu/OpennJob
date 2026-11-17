// Applies the theme the visitor chose (Light or Dark) before the page is drawn, so it does not flash.
// No choice stored: the device's own setting decides (CSS prefers-color-scheme).
try {
  var t = window.localStorage.getItem('opennjob.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  // storage blocked: the device's setting decides
}
