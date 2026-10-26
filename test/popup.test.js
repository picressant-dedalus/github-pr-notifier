import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPopup } from '../js/popup.js';
import { normalizeSettings } from '../js/settings.js';

const html = readFileSync(join(__dirname, '..', 'popup.html'), 'utf8');
const $ = (id) => document.getElementById(id);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const pr = (number, overrides = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`,
  createdAt: '2020-01-01T00:00:00Z', baseRefName: 'main',
  author: { login: 'author' }, automerge: { rebase: false }, ...overrides
});
const candidates = [
  { repo: 'o/r', number: 1, title: '<img src=x onerror=alert(1)>', eligible: true, reason: '' },
  { repo: 'o/r', number: 2, title: 'Second PR', eligible: true, reason: '' },
  { repo: 'o/r', number: 3, title: 'Own PR', eligible: false, reason: 'You cannot approve your own PR' }
];
const selection = { id: 'selection', login: 'me', candidates };
let savedBatch;
let interval;

beforeEach(async () => {
  document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>/i, '');
  document.body.dataset.page = 'test';
  interval = jest.spyOn(global, 'setInterval').mockImplementation(() => 1);
  $('approval-dialog').showModal = function () { this.open = true; $('approval-close').focus(); };
  $('approval-dialog').close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  savedBatch = null;
  await chrome.storage.local.set({
    settings: normalizeSettings({ token: 't', repos: ['o/r'], badgeMinAgeDays: 2 }),
    state: { repos: { 'o/r': { pullRequests: [pr(1), pr(2), pr(3)] } } }
  });
  chrome.runtime.sendMessage.mockImplementation(async (message) => {
    if (message.type === 'approval-status') return { ok: true, result: savedBatch };
    if (message.type === 'prepare-approvals') return { ok: true, result: selection };
    if (message.type === 'submit-approvals') {
      savedBatch = { id: 'batch', selectionId: selection.id, status: 'completed',
        targets: message.targets.map((target) => ({ ...target, status: 'succeeded' })) };
      return { ok: true, result: savedBatch };
    }
    return { ok: true };
  });
});

afterEach(() => interval.mockRestore());

async function open() {
  await initPopup();
  $('approve-prs').click();
  await tick();
}

it('starts unchecked, safely renders data and selects only eligible PRs with indeterminate state', async () => {
  await open();
  const inputs = [...$('approval-list').querySelectorAll('input')];
  expect(inputs.map((input) => input.checked)).toEqual([false, false, false]);
  expect(inputs[2].disabled).toBe(true);
  expect($('approval-list').querySelector('img')).toBeNull();
  expect($('approval-list').textContent).toContain('<img');
  expect($('approval-submit').disabled).toBe(true);
  inputs[0].click();
  expect($('approval-select-all').indeterminate).toBe(true);
  $('approval-select-all').click();
  expect(inputs.map((input) => input.checked)).toEqual([true, true, false]);
  expect($('approval-count').textContent).toBe('2 selected');
  $('approval-select-all').click();
  expect(inputs.every((input) => !input.checked)).toBe(true);
  expect($('approval-submit').disabled).toBe(true);
});

it('uses current-filter PRs and does not lose selection on storage refresh', async () => {
  await chrome.storage.local.set({
    popupFilter: 'old',
    state: { repos: { 'o/r': { pullRequests: [pr(1), pr(2, { createdAt: new Date().toISOString() })] } } }
  });
  await open();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'prepare-approvals', targets: [expect.objectContaining({ repo: 'o/r', number: 1 })]
  }));
  const input = $('approval-list').querySelector('input');
  input.click();
  await chrome.storage.local.set({ state: { repos: {} } });
  await tick();
  expect(input.isConnected).toBe(true);
  expect(input.checked).toBe(true);
});

it('submits only checked targets, guards duplicate clicks and shows results', async () => {
  await open();
  $('approval-list').querySelector('input').click();
  $('approval-submit').click();
  $('approval-submit').click();
  await tick();
  const messages = chrome.runtime.sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === 'submit-approvals');
  expect(messages).toEqual([{ type: 'submit-approvals', selectionId: 'selection', targets: [{ repo: 'o/r', number: 1 }] }]);
  expect($('approval-message').textContent).toContain('1 of 1 approved');
  expect($('approval-new').hidden).toBe(false);
  expect($('approval-retry').hidden).toBe(true);
  $('approval-close').click();
  expect(document.activeElement).toBe($('approve-prs'));
  expect(document.body.classList.contains('approvals-open')).toBe(false);
});

it('cancels without writing, including during preparation', async () => {
  let release;
  chrome.runtime.sendMessage.mockImplementation(async (message) => {
    if (message.type === 'prepare-approvals') return new Promise((resolve) => { release = resolve; });
    return { ok: true, result: null };
  });
  await open();
  expect($('approval-message').textContent).toContain('Checking');
  $('approval-close').click();
  release({ ok: true, result: selection });
  await tick();
  expect($('approval-dialog').open).toBe(false);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'submit-approvals' }));
});

it('restores stored progress and results, excluding successes on explicit recheck', async () => {
  savedBatch = { id: 'saved', status: 'completed', targets: [
    { repo: 'o/r', number: 1, status: 'succeeded' },
    { repo: 'o/r', number: 2, status: 'uncertain', error: 'Connection lost' }
  ] };
  await open();
  expect($('status').textContent).toContain('1/2 approved');
  expect($('approval-message').textContent).toContain('uncertain');
  $('approval-retry').click();
  await tick();
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
    type: 'prepare-approvals', targets: [savedBatch.targets[1]]
  });
  expect($('approval-list').querySelector('input').checked).toBe(false);
});

it('shows running progress from storage without allowing another submission', async () => {
  await open();
  $('approval-list').querySelector('input').click();
  await chrome.storage.local.set({ approvalBatch: {
    id: 'batch', selectionId: 'selection', status: 'running',
    targets: [{ repo: 'o/r', number: 1, status: 'running' }]
  } });
  expect($('approval-message').textContent).toContain('Approving');
  expect($('approval-new').disabled).toBe(true);
  expect($('approval-submit').hidden).toBe(true);
  $('approval-close').click();
  expect(chrome._store().approvalBatch.status).toBe('running');
});

it.each(['prepare-approvals', 'submit-approvals', 'approval-status'])('exposes %s messaging errors', async (type) => {
  const normal = chrome.runtime.sendMessage.getMockImplementation();
  chrome.runtime.sendMessage.mockImplementation(async (message) => {
    if (message.type === type) throw new Error('Worker unavailable');
    return normal(message);
  });
  await open();
  if (type === 'submit-approvals') {
    $('approval-list').querySelector('input').click();
    $('approval-submit').click();
    await tick();
    expect($('approval-submit').disabled).toBe(true);
  }
  expect($('approval-message').textContent).toContain('Worker unavailable');
});

it('shows an empty state without sending a preparation request', async () => {
  await chrome.storage.local.set({ state: { repos: {} } });
  await open();
  expect($('approval-message').textContent).toContain('No pull requests');
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prepare-approvals' }));
});
