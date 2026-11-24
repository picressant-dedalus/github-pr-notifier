// Refresh loop and toolbar badge. Used by the service worker (js/background.js).

import { fetchRepoPullRequests } from './github.js';
import { loadSettings, loadState, saveState } from './settings.js';

export const ALARM_NAME = 'refresh-pull-requests';
export const BADGE_COLOR = '#57606a'; // neutral GitHub grey
export const BADGE_ERROR_COLOR = '#cf222e';

/** True when the extension has what it needs to query GitHub. */
export function isConfigured(settings) {
  return Boolean(settings.token) && settings.repos.length > 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True if the PR was created at least `minAgeDays` days before `now`. */
export function isOldEnough(pr, minAgeDays, now = Date.now()) {
  if (!minAgeDays) return true;
  return now - new Date(pr.createdAt).getTime() >= minAgeDays * DAY_MS;
}

/**
 * Computes the toolbar badge from the stored state.
 * - text: number of waiting (open, non-draft) PRs over all configured repos, counting only PRs
 *         older than `settings.badgeMinAgeDays` days; '' when 0; '!' when no PR at all could be
 *         loaded because of errors.
 * - title: tooltip with the per-repository breakdown.
 */
export function computeBadge(settings, state, now = Date.now()) {
  if (!isConfigured(settings)) {
    return { text: '', color: BADGE_COLOR, title: 'GitHub PR Notifier — open the settings to configure it' };
  }
  const minAgeDays = settings.badgeMinAgeDays || 0;
  let total = 0;
  let loaded = 0;
  let errors = 0;
  const lines = [];
  for (const fullName of settings.repos) {
    const repo = state.repos && state.repos[fullName];
    if (!repo) continue;
    const prs = repo.pullRequests || [];
    const count = prs.filter((pr) => isOldEnough(pr, minAgeDays, now)).length;
    total += count;
    loaded += prs.length;
    if (repo.error) errors++;
    lines.push(`${fullName.split('/')[1]}: ${count}${repo.error ? ' (error)' : ''}`);
  }

  let text = total > 99 ? '99+' : total > 0 ? String(total) : '';
  let color = BADGE_COLOR;
  if (loaded === 0 && errors > 0) {
    text = '!';
    color = BADGE_ERROR_COLOR;
  }
  const age = minAgeDays ? ` older than ${minAgeDays} day${minAgeDays === 1 ? '' : 's'}` : '';
  const header = `${total} waiting pull request${total === 1 ? '' : 's'}${age}`;
  return { text, color, title: [header, ...lines].join('\n') };
}

export async function updateBadge(settings, state) {
  const badge = computeBadge(settings, state);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title: badge.title });
  return badge;
}

/** (Re)creates the periodic alarm that triggers refreshAll(). */
export async function scheduleRefresh(minutes) {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: minutes });
}

let inFlight = null;

/**
 * Fetches all configured repositories in parallel, stores the result and updates the badge.
 * Concurrent calls share the same in-flight refresh. On a per-repo error, the last known pull
 * requests are kept and the error message is stored next to them.
 */
export function refreshAll() {
  if (!inFlight) {
    inFlight = doRefresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doRefresh() {
  const settings = await loadSettings();
  const previous = await loadState();

  if (!isConfigured(settings)) {
    const state = { lastUpdated: null, refreshing: false, repos: {} };
    await saveState(state);
    await updateBadge(settings, state);
    return state;
  }

  await saveState({ ...previous, refreshing: true });

  const results = await Promise.allSettled(
    settings.repos.map((fullName) => fetchRepoPullRequests(settings.token, fullName, settings.adminTeamSlug))
  );

  const now = new Date().toISOString();
  const repos = {};
  settings.repos.forEach((fullName, i) => {
    const result = results[i];
    const old = previous.repos && previous.repos[fullName];
    repos[fullName] = result.status === 'fulfilled'
      ? { pullRequests: result.value, error: null, fetchedAt: now }
      : {
          pullRequests: old ? old.pullRequests || [] : [],
          error: (result.reason && result.reason.message) || String(result.reason),
          fetchedAt: old ? old.fetchedAt : null
        };
  });

  const state = { lastUpdated: now, refreshing: false, repos };
  await saveState(state);
  await updateBadge(settings, state);
  return state;
}
