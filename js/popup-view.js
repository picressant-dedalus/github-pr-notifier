// Pure DOM rendering of the popup (no chrome.* calls) so it can be unit tested with jsdom.
// User/GitHub data is always inserted with textContent / attributes, never innerHTML.

import { formatDuration } from './github.js';
import { ICONS } from './icons.js';
import { isOldEnough } from './poller.js';

/** Popup filters: every waiting PR, or only those older than settings.badgeMinAgeDays. */
export const FILTER_ALL = 'all';
export const FILTER_OLD = 'old';

const CHECKS = {
  success: { icon: 'check', label: 'Checks passed' },
  pending: { icon: 'dot', label: 'Checks in progress' },
  failure: { icon: 'cross', label: 'Checks failing' },
  none: { icon: 'dot', label: 'No checks' }
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(name, className) {
  const span = el('span', `icon ${className || ''}`.trim());
  span.innerHTML = ICONS[name]; // trusted, generated constant
  return span;
}

function link(href, className, text) {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function badge(className, text, title) {
  const span = el('span', `badge ${className}`, text);
  if (title) span.title = title;
  return span;
}

function automergeBadge(automerge) {
  if (automerge.rebase) {
    return badge('badge-automerge-on', 'automerge', 'Auto-merge (rebase) is enabled');
  }
  const title = automerge.enabled
    ? `Auto-merge is enabled with ${String(automerge.method).toLowerCase()}, not rebase`
    : 'Auto-merge is not enabled';
  return badge('badge-automerge-off', 'automerge', title);
}

function adminsFlag(state, teamSlug) {
  if (!state) return null;
  const team = `@${teamSlug}`;
  const flag = icon('flag', `flag flag-${state}`);
  flag.title = state === 'pending'
    ? `Review from ${team} is mandatory and still pending`
    : `Review from ${team} is mandatory (already reviewed by the team)`;
  flag.setAttribute('role', 'img');
  flag.setAttribute('aria-label', flag.title);
  return flag;
}

export function renderPullRequestCard(pr, { now = Date.now(), teamSlug = '', minAgeDays = 0 } = {}) {
  const card = el('article', 'pr-card');
  const old = minAgeDays > 0 && isOldEnough(pr, minAgeDays, now);
  card.classList.toggle('pr-old', old);
  card.dataset.number = String(pr.number);

  const top = el('div', 'pr-top');
  const checks = CHECKS[pr.checks] || CHECKS.none;
  const checksIcon = icon(checks.icon, `checks checks-${pr.checks}`);
  checksIcon.title = checks.label;
  checksIcon.setAttribute('role', 'img');
  checksIcon.setAttribute('aria-label', checks.label);
  top.append(checksIcon, link(pr.url, 'pr-title', pr.title));
  const flag = adminsFlag(pr.adminsReview, teamSlug);
  if (flag) top.append(flag);

  const meta = el('div', 'pr-meta');
  const author = link(pr.author.url || pr.url, 'pr-author');
  if (pr.author.avatarUrl) {
    const avatar = el('img', 'avatar');
    avatar.src = pr.author.avatarUrl;
    avatar.alt = '';
    author.append(avatar);
  }
  author.append(el('span', null, pr.author.login));
  const age = el('span', old ? 'pr-age pr-age-old' : 'pr-age');
  age.title = `Created ${new Date(pr.createdAt).toLocaleString()}`
    + (old ? ` — older than ${minAgeDays} day${minAgeDays === 1 ? '' : 's'}` : '');
  age.append(icon('clock'), el('span', null, formatDuration(pr.createdAt, now)));
  meta.append(author, el('span', 'pr-number', `#${pr.number}`), age);

  const badges = el('div', 'pr-badges');
  const branch = badge('badge-branch', null, `Target branch: ${pr.baseRefName}`);
  branch.append(icon('branch'), el('span', null, pr.baseRefName));
  badges.append(branch, automergeBadge(pr.automerge));

  card.append(top, meta, badges);
  return card;
}

function renderRepo(fullName, repo, prs, options) {
  const section = el('details', 'repo');
  section.open = true;
  section.dataset.repo = fullName;

  const summary = el('summary', 'repo-header');
  summary.append(
    link(`https://github.com/${fullName}/pulls`, 'repo-name', fullName.split('/')[1]),
    el('span', 'count', String(prs.length))
  );
  section.append(summary);

  if (repo && repo.error) {
    const error = el('div', 'repo-error');
    error.append(icon('alert'), el('span', null, repo.error));
    section.append(error);
  }
  if (!repo) {
    section.append(el('div', 'repo-empty', 'Not loaded yet…'));
  } else if (prs.length === 0 && !repo.error) {
    section.append(el('div', 'repo-empty', options.filter === FILTER_OLD
      ? `No pull request older than ${options.minAgeDays} day${options.minAgeDays === 1 ? '' : 's'}`
      : 'No open pull request'));
  }
  for (const pr of prs) section.append(renderPullRequestCard(pr, options));
  return section;
}

function renderFilters(filter, allCount, oldCount, minAgeDays) {
  const bar = el('div', 'filters');
  bar.setAttribute('role', 'tablist');
  const tab = (value, label, count, title) => {
    const button = el('button', `filter filter-${value}`);
    button.type = 'button';
    button.dataset.filter = value;
    button.title = title;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(filter === value));
    button.classList.toggle('active', filter === value);
    button.append(el('span', null, label), el('span', 'count', String(count)));
    return button;
  };
  bar.append(
    tab(FILTER_ALL, 'All', allCount, 'All waiting pull requests'),
    tab(FILTER_OLD, `Older than ${minAgeDays}d`, oldCount,
      `Pull requests waiting for more than ${minAgeDays} day${minAgeDays === 1 ? '' : 's'} (the ones counted on the toolbar badge)`)
  );
  return bar;
}

/**
 * Renders the popup body into `root`.
 * When settings.badgeMinAgeDays > 0, a filter bar lets the user switch between all PRs and the
 * old ones (those counted on the toolbar badge); repos without a matching PR are hidden in the
 * "old" view unless they have an error.
 * @param {HTMLElement} root
 * @param {{settings: object, state: object, now?: number, filter?: 'all'|'old'}} data
 * @returns {{total: number, old: number, shown: number}}
 */
export function renderPopup(root, { settings, state, now = Date.now(), filter = FILTER_ALL }) {
  root.replaceChildren();
  if (!settings.token || settings.repos.length === 0) {
    const empty = el('div', 'not-configured');
    empty.append(
      el('p', null, 'Add a GitHub token and the repositories to watch in the settings.'),
      el('button', 'btn btn-primary open-options', 'Open settings')
    );
    root.append(empty);
    return { total: 0, old: 0, shown: 0 };
  }

  const minAgeDays = settings.badgeMinAgeDays || 0;
  const activeFilter = minAgeDays > 0 && filter === FILTER_OLD ? FILTER_OLD : FILTER_ALL;
  const teamSlug = settings.adminTeamSlug ? `${settings.org}/${settings.adminTeamSlug}` : '';
  const options = { now, teamSlug, minAgeDays, filter: activeFilter };
  let total = 0;
  let old = 0;
  let shown = 0;
  const sections = [];
  for (const fullName of settings.repos) {
    const repo = state.repos ? state.repos[fullName] : undefined;
    const all = (repo && repo.pullRequests) || [];
    const olds = minAgeDays > 0 ? all.filter((pr) => isOldEnough(pr, minAgeDays, now)) : all;
    total += all.length;
    old += olds.length;
    const prs = activeFilter === FILTER_OLD ? olds : all;
    shown += prs.length;
    if (activeFilter === FILTER_OLD && prs.length === 0 && repo && !repo.error) continue;
    sections.push(renderRepo(fullName, repo, prs, options));
  }

  if (minAgeDays > 0) root.append(renderFilters(activeFilter, total, old, minAgeDays));
  if (activeFilter === FILTER_OLD && sections.length === 0) {
    root.append(el('div', 'repo-empty all-recent',
      `No pull request older than ${minAgeDays} day${minAgeDays === 1 ? '' : 's'} 🎉`));
  }
  root.append(...sections);
  return { total, old, shown };
}

/** PRs shown by renderPopup for the given settings/state/filter (same filtering). */
export function visiblePullRequests({ settings, state, now = Date.now(), filter = FILTER_ALL }) {
  const minAgeDays = settings.badgeMinAgeDays || 0;
  const old = minAgeDays > 0 && filter === FILTER_OLD;
  const result = [];
  for (const repo of settings.repos || []) {
    const prs = (state.repos && state.repos[repo] && state.repos[repo].pullRequests) || [];
    for (const pr of prs) if (!old || isOldEnough(pr, minAgeDays, now)) result.push({ ...pr, repo });
  }
  return result;
}

/** Pure selection/result rows. Candidate indexes are only local DOM keys, never PR identities. */
export function renderApprovalRows(root, candidates, { results = false } = {}) {
  root.replaceChildren();
  candidates.forEach((candidate, index) => {
    const row = el('div', 'approval-row');
    const label = el(results ? 'div' : 'label');
    const text = el('span');
    const identity = `${candidate.repo}#${candidate.number}`;
    text.append(el('strong', null, identity));
    if (candidate.url && candidate.url.startsWith('https://github.com/')) {
      text.append(link(candidate.url, null, candidate.title || identity));
    } else {
      text.append(el('span', null, candidate.title || ''));
    }
    text.append(el('span', 'approval-meta',
      [candidate.author, candidate.baseRefName].filter(Boolean).join(' \u2192 ')));
    const reason = el('span', 'approval-reason',
      results ? `${candidate.status}${candidate.error ? `: ${candidate.error}` : ''}` : candidate.reason);
    reason.id = `approval-reason-${index}`;
    text.append(reason);
    if (!results) {
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.index = String(index);
      checkbox.disabled = !candidate.eligible;
      checkbox.setAttribute('aria-describedby', reason.id);
      label.append(checkbox);
    }
    label.append(text);
    row.append(label);
    root.append(row);
  });
}

export function updateApprovalSelection(dialog) {
  const enabled = [...dialog.querySelectorAll('#approval-list input:not(:disabled)')];
  const selected = enabled.filter((input) => input.checked);
  const all = dialog.querySelector('#approval-select-all');
  all.disabled = enabled.length === 0;
  all.checked = enabled.length > 0 && enabled.length === selected.length;
  all.indeterminate = selected.length > 0 && selected.length < enabled.length;
  dialog.querySelector('#approval-count').textContent = `${selected.length} selected`;
  dialog.querySelector('#approval-submit').disabled = selected.length === 0;
}

/** "updated 3m ago" style text for the header. */
export function lastUpdatedText(state, now = Date.now()) {
  if (state.refreshing) return 'refreshing…';
  if (!state.lastUpdated) return 'never updated';
  return `updated ${formatDuration(state.lastUpdated, now)} ago`;
}
