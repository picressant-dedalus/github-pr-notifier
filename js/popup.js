// Popup glue: reads settings/state from storage, renders, and asks the worker to refresh.

import { ICONS } from './icons.js';
import { FILTER_ALL, lastUpdatedText, renderPopup } from './popup-view.js';
import { STATE_KEY, SETTINGS_KEY, loadSettings, loadState } from './settings.js';

// Last selected popup filter ('all' | 'old'), remembered between popup openings.
export const FILTER_KEY = 'popupFilter';

async function render() {
  const [settings, state, stored] = await Promise.all([loadSettings(), loadState(), chrome.storage.local.get(FILTER_KEY)]);
  const filter = stored[FILTER_KEY] || FILTER_ALL;
  const { total } = renderPopup(document.getElementById('content'), { settings, state, filter });
  document.getElementById('total').textContent = String(total);
  document.getElementById('last-updated').textContent = lastUpdatedText(state);
  document.getElementById('refresh').classList.toggle('spinning', Boolean(state.refreshing));
}

async function refresh() {
  document.getElementById('refresh').classList.add('spinning');
  try {
    await chrome.runtime.sendMessage({ type: 'refresh' });
  } finally {
    await render();
  }
}

export function initPopup() {
  document.getElementById('logo').innerHTML = ICONS.github;
  document.getElementById('refresh').innerHTML = ICONS.sync;
  document.getElementById('settings').innerHTML = ICONS.gear;

  document.getElementById('refresh').addEventListener('click', () => refresh());
  document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('content').addEventListener('click', (event) => {
    if (event.target.closest('.open-options')) chrome.runtime.openOptionsPage();
    const tab = event.target.closest('.filter');
    if (tab) chrome.storage.local.set({ [FILTER_KEY]: tab.dataset.filter }).then(render);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[STATE_KEY] || changes[SETTINGS_KEY])) render();
  });
  // Keep the "age" of PRs and the last-updated text current while the popup stays open.
  setInterval(render, 60 * 1000);

  return render();
}

if (typeof document !== 'undefined' && document.getElementById('content') && document.body.dataset.page === 'popup') {
  initPopup().catch((e) => console.error('GitHub PR Notifier popup', e));
}
