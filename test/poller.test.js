import { ALARM_NAME, BADGE_COLOR, BADGE_ERROR_COLOR, computeBadge, isOldEnough, refreshAll, scheduleRefresh } from '../js/poller.js';
import { loadState, saveSettings, saveState, normalizeSettings } from '../js/settings.js';
import { graphqlPage, jsonResponse, mockFetch, prNode } from './helpers.js';

const settings = normalizeSettings({ org: 'o', repos: ['o/a', 'o/b'], token: 't' });
const prs = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));

describe('computeBadge', () => {
  it('asks to configure when token or repos are missing', () => {
    expect(computeBadge(normalizeSettings({}), { repos: {} })).toMatchObject({ text: '', title: expect.stringContaining('settings') });
  });

  it('counts waiting PRs over configured repos with a neutral color', () => {
    const badge = computeBadge(settings, {
      repos: { 'o/a': { pullRequests: prs(2) }, 'o/b': { pullRequests: prs(3) }, 'o/old': { pullRequests: prs(9) } }
    });
    expect(badge).toEqual({ text: '5', color: BADGE_COLOR, title: '5 waiting pull requests\na: 2\nb: 3' });
  });

  it('shows nothing for zero, 99+ for big numbers and ! when only errors', () => {
    expect(computeBadge(settings, { repos: { 'o/a': { pullRequests: [] } } }).text).toBe('');
    expect(computeBadge(settings, { repos: { 'o/a': { pullRequests: prs(120) } } }).text).toBe('99+');
    const err = computeBadge(settings, { repos: { 'o/a': { pullRequests: [], error: 'boom' } } });
    expect(err).toMatchObject({ text: '!', color: BADGE_ERROR_COLOR });
    expect(err.title).toContain('a: 0 (error)');
  });
});

describe('badge minimum age', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const at = (iso) => ({ createdAt: iso });
  const aged = normalizeSettings({ org: 'o', repos: ['o/a', 'o/b'], token: 't', badgeMinAgeDays: 3 });

  it('isOldEnough compares the creation date with the threshold', () => {
    expect(isOldEnough(at('2026-10-12T12:00:00Z'), 3, now)).toBe(true);
    expect(isOldEnough(at('2026-10-12T12:00:01Z'), 3, now)).toBe(false);
    expect(isOldEnough(at('2026-10-15T11:59:00Z'), 0, now)).toBe(true);
  });

  it('only counts PRs older than badgeMinAgeDays', () => {
    const state = {
      repos: {
        'o/a': { pullRequests: [at('2026-10-01T00:00:00Z'), at('2026-10-14T00:00:00Z')] },
        'o/b': { pullRequests: [at('2026-10-15T00:00:00Z')] }
      }
    };
    expect(computeBadge(aged, state, now)).toEqual({
      text: '1', color: BADGE_COLOR, title: '1 waiting pull request older than 3 days\na: 1\nb: 0'
    });
  });

  it('shows no counter (not !) when PRs are loaded but all too recent, even with an error elsewhere', () => {
    const state = {
      repos: { 'o/a': { pullRequests: [at('2026-10-15T00:00:00Z')] }, 'o/b': { pullRequests: [], error: 'boom' } }
    };
    expect(computeBadge(aged, state, now)).toMatchObject({ text: '', color: BADGE_COLOR });
  });
});

it('scheduleRefresh recreates the alarm', async () => {
  await scheduleRefresh(7);
  expect(chrome.alarms.clear).toHaveBeenCalledWith(ALARM_NAME);
  expect(chrome.alarms.create).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 7, delayInMinutes: 7 });
});

describe('refreshAll', () => {
  it('fetches every repo, stores results and updates the badge; keeps old PRs on error', async () => {
    await saveSettings(settings);
    await saveState({ lastUpdated: null, repos: { 'o/b': { pullRequests: [{ number: 42 }], error: null, fetchedAt: 'old' } } });
    mockFetch({
      graphql: (body) => (body.variables.name === 'a'
        ? jsonResponse(graphqlPage([prNode({ number: 7 })]))
        : jsonResponse({ message: 'Server Error' }, { status: 500 })),
      rest: (url) => (url.includes('/o/a/') ? jsonResponse([]) : jsonResponse({}, { status: 500 }))
    });

    const [s1, s2] = await Promise.all([refreshAll(), refreshAll()]);
    expect(s1).toBe(s2); // concurrent calls share one refresh

    const state = await loadState();
    expect(state.refreshing).toBe(false);
    expect(state.repos['o/a'].pullRequests.map((p) => p.number)).toEqual([7]);
    expect(state.repos['o/a'].error).toBeNull();
    expect(state.repos['o/b']).toMatchObject({ pullRequests: [{ number: 42 }], error: expect.stringContaining('500'), fetchedAt: 'old' });
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' });
  });

  it('clears state when not configured', async () => {
    await saveSettings({ org: 'o', repos: [], token: '' });
    const state = await refreshAll();
    expect(state.repos).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });
});
