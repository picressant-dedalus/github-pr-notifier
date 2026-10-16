import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions, runConnectionTest } from '../js/options.js';
import { loadSettings, saveSettings } from '../js/settings.js';
import { jsonResponse } from './helpers.js';

const html = readFileSync(join(__dirname, '..', 'options.html'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>/i, '');
});

it('fills the form with defaults', async () => {
  await initOptions();
  expect(document.getElementById('org').value).toBe('dedalus-cis4u');
  expect(document.getElementById('refreshMinutes').value).toBe('5');
  expect(document.getElementById('badgeMinAgeDays').value).toBe('0');
  expect(document.getElementById('adminTeamSlug').value).toBe('cis4u-r-d-orbis-medication-admins');
  expect(document.getElementById('token').type).toBe('password');
});

it('saves normalised settings', async () => {
  await initOptions();
  document.getElementById('repos').value = 'orme-pharmacy\nhttps://github.com/x/y\n';
  document.getElementById('token').value = ' ghp_abc ';
  document.getElementById('refreshMinutes').value = '10';
  document.getElementById('badgeMinAgeDays').value = '3';
  document.getElementById('options-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  await tick();
  expect(await loadSettings()).toMatchObject({
    repos: ['dedalus-cis4u/orme-pharmacy', 'x/y'], token: 'ghp_abc', refreshMinutes: 10, badgeMinAgeDays: 3
  });
  expect(document.getElementById('status').textContent).toContain('2 repositories');
});

it('keeps all configured repositories when reopening the settings', async () => {
  const repos = ['dedalus-cis4u/orme-pharmacy', 'dedalus-cis4u/orme-pharmacy-surveillance', 'dedalus-cis4u/orme-pharmaceutical-validation'];
  await saveSettings({ org: 'dedalus-cis4u', repos, token: 't' });
  await initOptions();
  expect(document.getElementById('repos').value.split('\n')).toEqual(repos);
  expect(document.getElementById('repos-count').textContent).toBe('3 repositories recognised.');
});

it('saves repositories typed on one line separated by spaces', async () => {
  await initOptions();
  document.getElementById('repos').value = 'orme-pharmacy orme-pharmacy-surveillance orme-pharmaceutical-validation';
  document.getElementById('options-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  await tick();
  expect((await loadSettings()).repos).toHaveLength(3);
  expect(document.getElementById('repos').value.split('\n')).toHaveLength(3);
});

it('refuses to save and lists unrecognised repositories', async () => {
  await saveSettings({ org: 'o', repos: ['o/kept'], token: 't' });
  await initOptions();
  document.getElementById('repos').value = 'good\nbad!repo';
  document.getElementById('repos').dispatchEvent(new Event('input'));
  expect(document.getElementById('repos-count').textContent).toBe('1 repository recognised. Not recognised: bad!repo');
  document.getElementById('options-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  expect(document.getElementById('status').textContent).toContain('Not saved');
  expect(document.getElementById('status').classList.contains('error')).toBe(true);
  expect((await loadSettings()).repos).toEqual(['o/kept']);
  expect(document.getElementById('repos').value).toBe('good\nbad!repo');
});

it('toggles token visibility', async () => {
  await initOptions();
  document.getElementById('toggle-token').click();
  expect(document.getElementById('token').type).toBe('text');
});

it('tests the token and each repository', async () => {
  await saveSettings({ org: 'o', repos: ['o/ok', 'o/ko'], token: 't' });
  await initOptions();
  global.fetch.mockImplementation(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'me' }, { headers: { 'X-OAuth-Scopes': 'repo' } });
    if (url.includes('/o/ok/')) return jsonResponse([]);
    return jsonResponse({ message: 'Not Found' }, { status: 404 });
  });
  expect(await runConnectionTest()).toBe(false);
  const items = [...document.querySelectorAll('#test-result li')].map((li) => li.textContent);
  expect(items).toEqual([
    '✔ Authenticated as me (scopes: repo)',
    '✔ o/ok',
    '✘ o/ko: Repository o/ko not found or not accessible with this token'
  ]);
});
