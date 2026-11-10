/**
 * Service worker. Sets default settings on install, and runs the queue when the person
 * starts it from the popup (src/queue/runner.ts). It does nothing on its own otherwise.
 */
import { runQueue } from './queue/runner';

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['mode', 'apiBase']);
  await chrome.storage.local.set({
    mode: current.mode ?? 'hybrid',
    apiBase: current.apiBase ?? 'http://127.0.0.1:3000',
  });
});

chrome.runtime.onMessage.addListener((message: { type?: string }, sender, sendResponse) => {
  // Only the extension's own pages may start the queue: never a web page or a content script.
  if (message?.type !== 'OPENNJOB_QUEUE_START' || sender.id !== chrome.runtime.id || !(sender.url ?? '').startsWith(chrome.runtime.getURL(''))) return false;
  void runQueue();
  sendResponse({ started: true });
  return false;
});
