// MV3 service worker: wires Chrome events to the refresh loop in poller.js.
// The worker can be stopped at any time by Chrome, so all state lives in chrome.storage and the
// periodic refresh relies on chrome.alarms (not setInterval).

import { ALARM_NAME, enableAutomergeAll, refreshAll, scheduleRefresh, updateBadge } from './poller.js';
import { SETTINGS_KEY, loadSettings, loadState } from './settings.js';
import { loadApprovalBatch, prepareApprovals, submitApprovals } from './approvals.js';

async function restart() {
  const settings = await loadSettings();
  await scheduleRefresh(settings.refreshMinutes);
  await refreshAll();
}

chrome.runtime.onInstalled.addListener(() => {
  restart().catch((e) => console.error('GitHub PR Notifier: init failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  restart().catch((e) => console.error('GitHub PR Notifier: startup failed', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshAll().catch((e) => console.error('GitHub PR Notifier: refresh failed', e));
  }
});

// Settings saved from the options page: reschedule with the new interval and refresh now.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    restart().catch((e) => console.error('GitHub PR Notifier: restart failed', e));
  }
});

// Manual refresh requested by the popup.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && ['approval-status', 'prepare-approvals', 'submit-approvals'].includes(message.type)) {
    const operation = message.type === 'approval-status' ? loadApprovalBatch()
      : message.type === 'prepare-approvals' ? prepareApprovals(message.targets)
        : submitApprovals(message.selectionId, message.targets);
    operation.then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message && message.type === 'refresh') {
    refreshAll()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }
  if (message && message.type === 'enable-automerge') {
    enableAutomergeAll(message.targets || [])
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// Each time the worker wakes up: make sure the alarm exists and the badge reflects the cache.
(async () => {
  const settings = await loadSettings();
  if (!(await chrome.alarms.get(ALARM_NAME))) await scheduleRefresh(settings.refreshMinutes);
  await updateBadge(settings, await loadState());
})().catch((e) => console.error('GitHub PR Notifier: wake-up failed', e));
