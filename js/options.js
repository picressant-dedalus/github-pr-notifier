// Options page: edit settings, test the token and the access to each repository.

import { checkRepoAccess, testToken } from './github.js';
import { loadSettings, parseReposDetailed, saveSettings } from './settings.js';

function $(id) {
  return document.getElementById(id);
}

function readForm() {
  const org = $('org').value.trim();
  const { repos, invalid } = parseReposDetailed($('repos').value, org);
  return {
    org,
    repos,
    invalidRepos: invalid,
    token: $('token').value.trim(),
    refreshMinutes: Number($('refreshMinutes').value),
    badgeMinAgeDays: Number($('badgeMinAgeDays').value),
    adminTeamSlug: $('adminTeamSlug').value.trim()
  };
}

function fillForm(settings) {
  $('org').value = settings.org;
  $('repos').value = settings.repos.join('\n');
  $('token').value = settings.token;
  $('refreshMinutes').value = String(settings.refreshMinutes);
  $('badgeMinAgeDays').value = String(settings.badgeMinAgeDays);
  $('adminTeamSlug').value = settings.adminTeamSlug;
  updateReposCount();
}

function updateReposCount() {
  const { repos, invalid } = parseReposDetailed($('repos').value, $('org').value.trim());
  const count = repos.length;
  const hint = $('repos-count');
  hint.textContent = `${count} repositor${count === 1 ? 'y' : 'ies'} recognised.`
    + (invalid.length ? ` Not recognised: ${invalid.join(', ')}` : '');
  hint.classList.toggle('error', invalid.length > 0);
}

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function addResult(list, ok, text) {
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'ko';
  li.textContent = `${ok ? '✔' : '✘'} ${text}`;
  list.append(li);
}

/** Checks the token, then the access to each listed repository; results are listed below the field. */
export async function runConnectionTest() {
  const list = $('test-result');
  list.replaceChildren();
  const { token, repos } = readForm();
  if (!token) {
    addResult(list, false, 'Enter a token first');
    return false;
  }
  let allOk = true;
  try {
    const { login, scopes } = await testToken(token);
    addResult(list, true, `Authenticated as ${login}${scopes.length ? ` (scopes: ${scopes.join(', ')})` : ''}`);
  } catch (e) {
    addResult(list, false, e.message);
    return false;
  }
  const results = await Promise.allSettled(repos.map((repo) => checkRepoAccess(token, repo)));
  results.forEach((result, i) => {
    const ok = result.status === 'fulfilled';
    allOk = allOk && ok;
    addResult(list, ok, ok ? repos[i] : `${repos[i]}: ${result.reason.message}`);
  });
  return allOk;
}

export async function initOptions() {
  fillForm(await loadSettings());

  $('repos').addEventListener('input', updateReposCount);
  $('org').addEventListener('input', updateReposCount);

  $('toggle-token').addEventListener('click', () => {
    const input = $('token');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggle-token').textContent = hidden ? 'Hide' : 'Show';
  });

  $('test').addEventListener('click', async () => {
    $('test').disabled = true;
    try {
      await runConnectionTest();
    } finally {
      $('test').disabled = false;
    }
  });

  $('options-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = readForm();
    if (!form.org) {
      setStatus('The organisation is required.', true);
      return;
    }
    if (form.invalidRepos.length) {
      setStatus(`Not saved: unrecognised repositories (${form.invalidRepos.join(', ')}). Use name, owner/name or a GitHub URL.`, true);
      return;
    }
    const { invalidRepos, ...settings } = form;
    const saved = await saveSettings(settings);
    fillForm(saved);
    setStatus(`Saved — ${saved.repos.length} repositor${saved.repos.length === 1 ? 'y' : 'ies'}, refresh every ${saved.refreshMinutes} min.`);
  });
}

if (typeof document !== 'undefined' && document.body && document.body.dataset.page === 'options') {
  initOptions().catch((e) => setStatus(`Error: ${e.message}`, true));
}
