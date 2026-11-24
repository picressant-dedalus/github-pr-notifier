import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPopup } from '../js/popup.js';
import { normalizeSettings } from '../js/settings.js';

const html = readFileSync(join(__dirname, '..', 'popup.html'), 'utf8');
const $ = (name) => document.getElementById(`automerge-${name}`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const pr = (number, overrides = {}) => ({
  number, nodeId: `node${number}`, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`,
  createdAt: '2020-01-01T00:00:00Z', baseRefName: 'main', author: { login: 'author' },
  automerge: { rebase: false }, ...overrides
});
const candidates = [
  { repo: 'o/r', number: 1, title: '<img src=x onerror=alert(1)>', eligible: true, reason: '' },
  { repo: 'o/r', number: 2, title: 'Second PR', eligible: true, reason: '' },
  { repo: 'o/r', number: 3, title: 'Already rebase', eligible: false, reason: 'Auto-merge (rebase) is already enabled' }
];
let saved;
let interval;
let confirm;

function installDOM() {
  document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>/i, '');
  document.body.dataset.page = 'test';
  for (const prefix of ['approval', 'automerge']) {
    const dialog = document.getElementById(`${prefix}-dialog`);
    dialog.showModal = function () { this.open = true; document.getElementById(`${prefix}-close`).focus(); };
    dialog.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  }
}

beforeEach(async () => {
  installDOM();
  interval = jest.spyOn(global, 'setInterval').mockImplementation(() => 1);
  confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  let nextId = 0;
  crypto.randomUUID = jest.fn(() => `preparation-${++nextId}`);
  saved = null;
  await chrome.storage.local.set({
    settings: normalizeSettings({ token: 't', repos: ['o/r'], badgeMinAgeDays: 2 }),
    state: { repos: { 'o/r': { pullRequests: [pr(1), pr(2), pr(3)] } } }
  });
  chrome.runtime.sendMessage.mockImplementation(async (message) => {
    if (message.type === 'approval-status') return { ok: true, result: null };
    if (message.type === 'automerge-status') return { ok: true, result: saved };
    if (message.type === 'prepare-automerge') return { ok: true, result: { id: 'selection', candidates } };
    if (message.type === 'submit-automerge') {
      saved = {
        id: 'batch', selectionId: 'selection', status: 'completed',
        targets: message.targets.map((target) => ({ ...target, status: 'succeeded' }))
      };
      return { ok: true, result: saved };
    }
    if (message.type === 'dismiss-automerge') {
      saved = null;
      return { ok: true };
    }
    return { ok: true };
  });
});

afterEach(() => {
  interval.mockRestore();
  confirm.mockRestore();
});

async function open() {
  await initPopup();
  $('prs').click();
  await tick();
}

it('starts unchecked, shows disabled reasons, safely renders and selects eligible rows only', async () => {
  await open();
  const inputs = [...$('list').querySelectorAll('input')];
  expect(inputs.map((input) => input.checked)).toEqual([false, false, false]);
  expect(inputs[2].disabled).toBe(true);
  expect($('list').textContent).toContain('already enabled');
  expect($('list').textContent).toContain('<img');
  expect($('list').querySelector('img')).toBeNull();
  expect($('submit').disabled).toBe(true);
  expect(inputs[0].getAttribute('aria-describedby')).toBe('automerge-reason-0');
  inputs[0].click();
  expect($('select-all').indeterminate).toBe(true);
  $('select-all').click();
  expect(inputs.map((input) => input.checked)).toEqual([true, true, false]);
  expect($('count').textContent).toBe('2 selected');
  $('select-all').click();
  expect($('submit').disabled).toBe(true);
});

it('uses active-filter targets and preserves selection on refresh', async () => {
  await chrome.storage.local.set({
    popupFilter: 'old', state: { repos: { 'o/r': {
      pullRequests: [pr(1), pr(2, { createdAt: new Date().toISOString() })]
    } } }
  });
  await open();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'prepare-automerge', targets: [expect.objectContaining({ number: 1, repo: 'o/r' })]
  }));
  const input = $('list').querySelector('input');
  input.click();
  await chrome.storage.local.set({ state: { repos: {} } });
  await tick();
  expect(input.isConnected).toBe(true);
  expect(input.checked).toBe(true);
});

it('submits only checked identities once, without another confirmation, and returns focus on close', async () => {
  await open();
  $('list').querySelector('input').click();
  $('submit').click();
  $('submit').click();
  await tick();
  const messages = chrome.runtime.sendMessage.mock.calls.map(([value]) => value).filter((value) => value.type === 'submit-automerge');
  expect(messages).toEqual([{ type: 'submit-automerge', selectionId: 'selection', targets: [{ repo: 'o/r', number: 1 }] }]);
  expect(confirm).not.toHaveBeenCalled();
  expect($('message').textContent).toContain('1 of 1 enabled');
  $('close').click();
  expect(document.activeElement).toBe($('prs'));
  expect(document.body.classList.contains('automerge-open')).toBe(false);
  expect($('summary').textContent).toContain('1/1 enabled');
});

it('ignores stale preparation/progress after cancellation without writing', async () => {
  const normal = chrome.runtime.sendMessage.getMockImplementation();
  let release;
  chrome.runtime.sendMessage.mockImplementation((message) => message.type === 'prepare-automerge'
    ? new Promise((resolve) => { release = resolve; }) : normal(message));
  await open();
  expect([...$('list').querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
  const { preparationId } = chrome.runtime.sendMessage.mock.calls.map(([value]) => value).find((value) => value.type === 'prepare-automerge');
  await chrome.storage.local.set({ automergePreparation: { id: preparationId, processed: 2, total: 3 } });
  expect($('message').textContent).toContain('2 of 3');
  await chrome.storage.local.set({ automergePreparation: { id: preparationId, processed: 1, total: 3 } });
  expect($('message').textContent).toContain('2 of 3');
  $('close').click();
  const message = $('message').textContent;
  release({ ok: true, result: { id: 'selection', candidates } });
  await chrome.storage.local.set({ automergePreparation: { id: preparationId, processed: 3, total: 3 } });
  await tick();
  expect($('dialog').open).toBe(false);
  expect($('message').textContent).toBe(message);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'submit-automerge' }));
});

it('restores persisted results, rechecks only unsuccessful PRs unchecked and dismisses explicitly', async () => {
  saved = { id: 'batch', status: 'completed', targets: [
    { ...candidates[0], status: 'succeeded' }, { ...candidates[1], status: 'uncertain', error: 'Connection lost' }
  ] };
  await open();
  expect($('message').textContent).toContain('uncertain');
  expect($('retry').hidden).toBe(false);
  $('retry').click();
  await tick();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'prepare-automerge', targets: [expect.objectContaining({ number: 2 })]
  }));
  expect([...$('list').querySelectorAll('input')].every((input) => !input.checked)).toBe(true);
  $('close').click();
  $('prs').click();
  await tick();
  $('dismiss').click();
  await tick();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'dismiss-automerge', batchId: 'batch' });
  expect($('dialog').open).toBe(false);
  expect($('summary').hidden).toBe(true);
});

it('tracks running progress after closure and restores it on reopen', async () => {
  saved = { id: 'batch', status: 'running', targets: [{ ...candidates[0], status: 'pending' }] };
  await open();
  expect($('new').disabled).toBe(true);
  expect($('dismiss').hidden).toBe(true);
  $('close').click();
  saved = { ...saved, status: 'completed', targets: [{ ...candidates[0], status: 'succeeded' }] };
  await chrome.storage.local.set({ automergeBatch: saved });
  expect($('summary').textContent).toContain('1/1 enabled');
  $('prs').click();
  await tick();
  expect($('message').textContent).toContain('1 of 1 enabled');
  expect($('new').disabled).toBe(false);
});

it('keeps auto-merge and approval summaries and dismissals independent', async () => {
  saved = { id: 'auto', status: 'completed', targets: [{ ...candidates[0], status: 'succeeded' }] };
  const normal = chrome.runtime.sendMessage.getMockImplementation();
  const approval = { id: 'approval', status: 'completed', targets: [{ repo: 'o/r', number: 4, status: 'succeeded' }] };
  chrome.runtime.sendMessage.mockImplementation((message) => message.type === 'approval-status'
    ? Promise.resolve({ ok: true, result: approval }) : normal(message));
  await initPopup();
  const status = document.getElementById('status');
  expect(status.textContent).toContain('Approval batch');
  expect($('summary').textContent).toContain('Auto-merge batch');
  $('summary').querySelector('button').click();
  await tick();
  expect($('summary').hidden).toBe(true);
  expect(status.textContent).toContain('Approval batch');
  expect(status.hidden).toBe(false);
});

it.each(['prepare-automerge', 'submit-automerge', 'automerge-status', 'dismiss-automerge'])('surfaces %s failures', async (type) => {
  const normal = chrome.runtime.sendMessage.getMockImplementation();
  if (type === 'dismiss-automerge') saved = { id: 'batch', status: 'completed', targets: [] };
  chrome.runtime.sendMessage.mockImplementation((message) => message.type === type
    ? Promise.reject(new Error('Worker unavailable')) : normal(message));
  await open();
  if (type === 'submit-automerge') {
    $('list').querySelector('input').click();
    $('submit').click();
    await tick();
    expect($('submit').disabled).toBe(true);
  } else if (type === 'dismiss-automerge') {
    $('dismiss').click();
    await tick();
    expect($('dismiss').disabled).toBe(false);
  }
  expect($('message').textContent).toContain('Worker unavailable');
});

it('distinguishes no matching PRs from no eligible PRs', async () => {
  await chrome.storage.local.set({ state: { repos: {} } });
  await open();
  expect($('message').textContent).toContain('No pull requests match');
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prepare-automerge' }));
  $('close').click();
  await chrome.storage.local.set({ state: { repos: { 'o/r': { pullRequests: [pr(3)] } } } });
  const normal = chrome.runtime.sendMessage.getMockImplementation();
  chrome.runtime.sendMessage.mockImplementation((message) => message.type === 'prepare-automerge'
    ? Promise.resolve({ ok: true, result: { id: 'selection', candidates: [candidates[2]] } }) : normal(message));
  $('prs').click();
  await tick();
  expect($('message').textContent).toContain('No eligible PRs');
  expect($('select-all').disabled).toBe(true);
});
