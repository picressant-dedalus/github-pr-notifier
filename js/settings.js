// Settings and cached state, persisted in chrome.storage.local (never synced: it holds the token).

export const SETTINGS_KEY = 'settings';
export const STATE_KEY = 'state';

export const DEFAULT_SETTINGS = Object.freeze({
  org: 'dedalus-cis4u',
  repos: [],
  token: '',
  refreshMinutes: 5,
  // Toolbar badge only counts PRs created at least this many days ago (0 = count all).
  badgeMinAgeDays: 0,
  adminTeamSlug: 'cis4u-r-d-orbis-medication-admins'
});

export const MIN_REFRESH_MINUTES = 1;

/**
 * Converts one repository entry to "owner/name", or returns null if it is not recognised.
 * Accepted: "name" (uses defaultOrg), "owner/name", "https://github.com/owner/name[/...][?…][#…]",
 * "git@github.com:owner/name.git".
 */
export function parseRepoEntry(entry, defaultOrg) {
  const path = String(entry || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = path.split('/').filter(Boolean);
  let fullName;
  if (parts.length === 1) {
    if (!defaultOrg) return null;
    fullName = `${defaultOrg}/${parts[0]}`;
  } else if (parts.length > 1) {
    fullName = `${parts[0]}/${parts[1]}`;
  } else {
    return null;
  }
  fullName = fullName.replace(/\.git$/i, '');
  return /^[\w.-]+\/[\w.-]+$/.test(fullName) ? fullName : null;
}

/**
 * Parses the free-text repository list from the options page.
 * Entries are separated by new lines, spaces, commas or semicolons; bullets ("-", "*", "•") and
 * comments ("#" at the start of a line or after a space) are ignored. See parseRepoEntry for the
 * accepted formats. Duplicates are removed (case-insensitive).
 * @returns {{ repos: string[], invalid: string[] }} "owner/name" list in input order, and the
 *          entries that could not be recognised (so the UI can report them instead of dropping them)
 */
export function parseReposDetailed(text, defaultOrg) {
  const repos = [];
  const invalid = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const content = line.replace(/(^|\s)#.*$/, '');
    for (const token of content.split(/[\s,;]+/)) {
      if (!token || /^[-*•]+$/.test(token)) continue;
      const fullName = parseRepoEntry(token, defaultOrg);
      if (!fullName) {
        invalid.push(token);
        continue;
      }
      const key = fullName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(fullName);
    }
  }
  return { repos, invalid };
}

/** Same as parseReposDetailed but only returns the recognised "owner/name" list. */
export function parseRepos(text, defaultOrg) {
  return parseReposDetailed(text, defaultOrg).repos;
}

/** Normalises user-provided settings (types, defaults, minimum refresh). */
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  s.org = String(s.org || '').trim();
  s.token = String(s.token || '').trim();
  s.adminTeamSlug = String(s.adminTeamSlug || '').trim().replace(/^@?[\w.-]+\//, '').toLowerCase();
  s.repos = Array.isArray(s.repos) ? s.repos : parseRepos(s.repos, s.org);
  const minutes = Number(s.refreshMinutes);
  s.refreshMinutes = Number.isFinite(minutes) && minutes >= MIN_REFRESH_MINUTES
    ? Math.round(minutes)
    : DEFAULT_SETTINGS.refreshMinutes;
  const days = Number(s.badgeMinAgeDays);
  s.badgeMinAgeDays = Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_SETTINGS.badgeMinAgeDays;
  return s;
}

export async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

/**
 * State shape:
 * {
 *   lastUpdated: ISO string | null,
 *   refreshing: boolean,
 *   repos: { [fullName]: { pullRequests: PullRequest[], error: string | null, fetchedAt: ISO string } }
 * }
 */
export async function loadState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || { lastUpdated: null, refreshing: false, repos: {} };
}

export async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}
