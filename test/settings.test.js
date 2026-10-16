import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, parseRepos, parseReposDetailed, saveSettings } from '../js/settings.js';

describe('parseRepos', () => {
  it('accepts names, owner/name and URLs, ignoring blanks, comments and duplicates', () => {
    const text = `
      orme-pharmacy
      # a comment
      other-org/tool
      https://github.com/dedalus-cis4u/orme-pharmacy-surveillance/pulls
      git@github.com:dedalus-cis4u/with-git.git
      ORME-PHARMACY
      extra-repo
    `;
    expect(parseRepos(text, 'dedalus-cis4u')).toEqual([
      'dedalus-cis4u/orme-pharmacy',
      'other-org/tool',
      'dedalus-cis4u/orme-pharmacy-surveillance',
      'dedalus-cis4u/with-git',
      'dedalus-cis4u/extra-repo'
    ]);
  });

  it('accepts spaces, semicolons, bullets, inline comments and URLs with query/fragment', () => {
    const text = `- orme-pharmacy orme-pharmacy-surveillance; orme-pharmaceutical-validation
      * https://github.com/dedalus-cis4u/orme-config#readme  # main config
      • github.com/dedalus-cis4u/orme-ui?tab=readme-ov-file
      https://github.com/dedalus-cis4u/orme-api.git`;
    expect(parseReposDetailed(text, 'dedalus-cis4u')).toEqual({
      repos: [
        'dedalus-cis4u/orme-pharmacy',
        'dedalus-cis4u/orme-pharmacy-surveillance',
        'dedalus-cis4u/orme-pharmaceutical-validation',
        'dedalus-cis4u/orme-config',
        'dedalus-cis4u/orme-ui',
        'dedalus-cis4u/orme-api'
      ],
      invalid: []
    });
  });

  it('reports unrecognised entries instead of silently dropping them', () => {
    expect(parseReposDetailed('ok-repo\nbad!repo\nhttps://github.com/', 'o')).toEqual({
      repos: ['o/ok-repo'], invalid: ['bad!repo', 'https://github.com/']
    });
  });

  it('skips bare names when no organisation is set', () => {
    expect(parseRepos('repo\norg/repo2', '')).toEqual(['org/repo2']);
  });
});

describe('normalizeSettings', () => {
  it('applies defaults', () => {
    expect(normalizeSettings()).toEqual({ ...DEFAULT_SETTINGS, repos: [] });
  });

  it('fixes invalid refresh interval, trims values and strips @org/ from the team', () => {
    const s = normalizeSettings({ refreshMinutes: '0', token: ' t ', adminTeamSlug: '@dedalus-cis4u/My-Team', repos: 'a\nb' });
    expect(s.refreshMinutes).toBe(5);
    expect(s.token).toBe('t');
    expect(s.adminTeamSlug).toBe('my-team');
    expect(s.repos).toEqual(['dedalus-cis4u/a', 'dedalus-cis4u/b']);
  });

  it('normalises the badge minimum age (non-negative integer, default 0)', () => {
    expect(normalizeSettings({ badgeMinAgeDays: '2.7' }).badgeMinAgeDays).toBe(2);
    expect(normalizeSettings({ badgeMinAgeDays: -1 }).badgeMinAgeDays).toBe(0);
    expect(normalizeSettings({ badgeMinAgeDays: 'abc' }).badgeMinAgeDays).toBe(0);
    expect(normalizeSettings({}).badgeMinAgeDays).toBe(0);
  });
});

it('saves and loads settings from chrome.storage.local', async () => {
  await saveSettings({ org: 'o', repos: ['o/r'], token: 'x', refreshMinutes: 10 });
  const loaded = await loadSettings();
  expect(loaded).toMatchObject({ org: 'o', repos: ['o/r'], token: 'x', refreshMinutes: 10 });
  expect(chrome.storage.local.set).toHaveBeenCalled();
});
