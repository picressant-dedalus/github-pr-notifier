import { FILTER_OLD, lastUpdatedText, renderPopup, renderPullRequestCard } from '../js/popup-view.js';
import { normalizeSettings } from '../js/settings.js';

const now = Date.parse('2026-10-15T12:00:00Z');
const pr = (overrides = {}) => ({
  number: 978,
  title: 'chore(ci): tiered Renovate schedule',
  url: 'https://github.com/o/r/pull/978',
  createdAt: '2026-10-13T08:00:00Z',
  baseRefName: '400XXXX/develop',
  author: { login: 'awrrl', avatarUrl: 'https://avatars/awrrl', url: 'https://github.com/awrrl' },
  checks: 'success',
  automerge: { enabled: false, method: null, rebase: false },
  adminsReview: null,
  ...overrides
});

describe('renderPullRequestCard', () => {
  it('shows title, author, age, branch badge and red automerge badge', () => {
    const card = renderPullRequestCard(pr(), { now, teamSlug: 'o/admins' });
    expect(card.querySelector('.pr-title').textContent).toBe('chore(ci): tiered Renovate schedule');
    expect(card.querySelector('.pr-title').href).toBe('https://github.com/o/r/pull/978');
    expect(card.querySelector('.pr-title').target).toBe('_blank');
    expect(card.querySelector('.pr-author').textContent).toBe('awrrl');
    expect(card.querySelector('.avatar').src).toBe('https://avatars/awrrl');
    expect(card.querySelector('.pr-number').textContent).toBe('#978');
    expect(card.querySelector('.pr-age').textContent).toBe('2d 4h');
    expect(card.querySelector('.badge-branch').textContent).toBe('400XXXX/develop');
    const automerge = card.querySelector('.badge-automerge-off');
    expect(automerge.textContent).toBe('automerge');
    expect(automerge.title).toBe('Auto-merge is not enabled');
    expect(card.querySelector('.flag')).toBeNull();
  });

  it('shows green automerge badge only for rebase', () => {
    expect(renderPullRequestCard(pr({ automerge: { enabled: true, method: 'REBASE', rebase: true } }), { now })
      .querySelector('.badge-automerge-on')).not.toBeNull();
    const squash = renderPullRequestCard(pr({ automerge: { enabled: true, method: 'SQUASH', rebase: false } }), { now });
    expect(squash.querySelector('.badge-automerge-off').title).toContain('squash');
  });

  it.each([
    ['success', 'Checks passed'], ['pending', 'Checks in progress'], ['failure', 'Checks failing'], ['none', 'No checks']
  ])('check status %s', (checks, label) => {
    const icon = renderPullRequestCard(pr({ checks }), { now }).querySelector(`.checks-${checks}`);
    expect(icon.title).toBe(label);
    expect(icon.querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['pending', 'still pending'], ['reviewed', 'already reviewed']
  ])('admins flag %s', (state, text) => {
    const flag = renderPullRequestCard(pr({ adminsReview: state }), { now, teamSlug: 'o/admins' }).querySelector(`.flag-${state}`);
    expect(flag.title).toContain('@o/admins');
    expect(flag.title).toContain(text);
  });

  it('never interprets PR data as HTML', () => {
    const card = renderPullRequestCard(pr({ title: '<img src=x onerror=alert(1)>' }), { now });
    expect(card.querySelector('.pr-title img')).toBeNull();
    expect(card.querySelector('.pr-title').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('renderPopup', () => {
  it('invites to configure when needed', () => {
    const root = document.createElement('div');
    expect(renderPopup(root, { settings: normalizeSettings({}), state: { repos: {} }, now })).toEqual({ total: 0, old: 0, shown: 0 });
    expect(root.querySelector('.open-options')).not.toBeNull();
  });

  it('renders one section per configured repo, in settings order, with errors and empty states', () => {
    const root = document.createElement('div');
    const settings = normalizeSettings({ org: 'o', token: 't', repos: ['o/b', 'o/a', 'o/c'] });
    const state = {
      repos: {
        'o/a': { pullRequests: [pr(), pr({ number: 1 })], error: null },
        'o/b': { pullRequests: [], error: 'Invalid or expired GitHub token' }
      }
    };
    const { total } = renderPopup(root, { settings, state, now });
    expect(total).toBe(2);
    const sections = [...root.querySelectorAll('.repo')];
    expect(sections.map((s) => s.dataset.repo)).toEqual(['o/b', 'o/a', 'o/c']);
    expect(sections[0].querySelector('.repo-error').textContent).toContain('Invalid or expired');
    expect(sections[1].querySelectorAll('.pr-card')).toHaveLength(2);
    expect(sections[1].querySelector('.count').textContent).toBe('2');
    expect(sections[1].querySelector('.repo-name').href).toBe('https://github.com/o/a/pulls');
    expect(sections[2].querySelector('.repo-empty').textContent).toBe('Not loaded yet…');
    expect(root.querySelector('.filters')).toBeNull();
  });

  describe('old pull requests (badgeMinAgeDays)', () => {
    const settings = normalizeSettings({ org: 'o', token: 't', repos: ['o/a', 'o/b', 'o/c'], badgeMinAgeDays: 2 });
    const state = {
      repos: {
        'o/a': { pullRequests: [pr({ number: 1 }), pr({ number: 2, createdAt: '2026-10-15T08:00:00Z' })], error: null },
        'o/b': { pullRequests: [pr({ number: 3, createdAt: '2026-10-15T08:00:00Z' })], error: null },
        'o/c': { pullRequests: [], error: 'boom' }
      }
    };

    it('shows the filter bar with counts and highlights old cards in the "all" view', () => {
      const root = document.createElement('div');
      expect(renderPopup(root, { settings, state, now })).toEqual({ total: 3, old: 1, shown: 3 });
      const tabs = [...root.querySelectorAll('.filter')];
      expect(tabs.map((t) => t.textContent)).toEqual(['All3', 'Older than 2d1']);
      expect(tabs[0].classList.contains('active')).toBe(true);
      expect(tabs[1].dataset.filter).toBe('old');
      expect(root.querySelectorAll('.pr-card')).toHaveLength(3);
      const old = root.querySelectorAll('.pr-old');
      expect(old).toHaveLength(1);
      expect(old[0].dataset.number).toBe('1');
      expect(old[0].querySelector('.pr-age-old').title).toContain('older than 2 days');
    });

    it('lists only old PRs in the "old" view, hiding repos without any (except errors)', () => {
      const root = document.createElement('div');
      expect(renderPopup(root, { settings, state, now, filter: FILTER_OLD })).toEqual({ total: 3, old: 1, shown: 1 });
      expect(root.querySelector('.filter-old').getAttribute('aria-selected')).toBe('true');
      expect([...root.querySelectorAll('.repo')].map((s) => s.dataset.repo)).toEqual(['o/a', 'o/c']);
      expect(root.querySelector('[data-repo="o/a"] .count').textContent).toBe('1');
      expect([...root.querySelectorAll('.pr-card')].map((c) => c.dataset.number)).toEqual(['1']);
    });

    it('shows a message when no PR is old enough', () => {
      const root = document.createElement('div');
      const recent = { repos: { 'o/a': { pullRequests: [pr({ createdAt: '2026-10-15T08:00:00Z' })], error: null } } };
      renderPopup(root, { settings: { ...settings, repos: ['o/a'] }, state: recent, now, filter: FILTER_OLD });
      expect(root.querySelector('.all-recent').textContent).toContain('No pull request older than 2 days');
      expect(root.querySelector('.pr-card')).toBeNull();
    });

    it('ignores the "old" filter when no minimum age is set', () => {
      const root = document.createElement('div');
      const all = { ...settings, badgeMinAgeDays: 0 };
      expect(renderPopup(root, { settings: all, state, now, filter: FILTER_OLD }).shown).toBe(3);
      expect(root.querySelector('.filters')).toBeNull();
      expect(root.querySelector('.pr-old')).toBeNull();
    });
  });
});

it('lastUpdatedText', () => {
  expect(lastUpdatedText({ refreshing: true }, now)).toBe('refreshing…');
  expect(lastUpdatedText({ lastUpdated: null }, now)).toBe('never updated');
  expect(lastUpdatedText({ lastUpdated: '2026-10-15T11:57:00Z' }, now)).toBe('updated 3m ago');
});
