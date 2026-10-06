/**
 * Service worker. Deliberately tiny: it only sets default settings on install.
 * All work happens in the popup (user gesture) and the content script (the page).
 */
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['mode', 'apiBase']);
  await chrome.storage.local.set({
    mode: current.mode ?? 'hybrid',
    apiBase: current.apiBase ?? 'http://127.0.0.1:3000',
  });
});
