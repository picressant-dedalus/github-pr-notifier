// Popup glue: reads settings/state from storage, renders, and asks the worker to refresh.

import { ICONS } from './icons.js';
import { FILTER_ALL, lastUpdatedText, renderApprovalRows, renderPopup, updateApprovalSelection, visiblePullRequests } from './popup-view.js';
import { STATE_KEY, SETTINGS_KEY, loadSettings, loadState } from './settings.js';

// Last selected popup filter ('all' | 'old'), remembered between popup openings.
export const FILTER_KEY = 'popupFilter';
const APPROVAL_BATCH_KEY = 'approvalBatch';
const APPROVAL_PREPARATION_KEY = 'approvalPreparation';

function initApprovals() {
  const dialog = document.getElementById('approval-dialog');
  const opener = document.getElementById('approve-prs');
  const list = document.getElementById('approval-list');
  const message = document.getElementById('approval-message');
  const submit = document.getElementById('approval-submit');
  const retry = document.getElementById('approval-retry');
  const newSelection = document.getElementById('approval-new');
  const dismiss = document.getElementById('approval-dismiss');
  const all = document.getElementById('approval-select-all');
  let selection = null;
  let batch = null;
  let busy = false;
  let generation = 0;
  let preparationId = null;
  let processed = 0;

  async function request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response || !response.ok) throw new Error((response && response.error) || 'No response from worker');
    return response.result;
  }

  function showBatch(result) {
    batch = result;
    selection = null;
    preparationId = null;
    busy = result.status === 'running';
    renderApprovalRows(list, result.targets, { results: true });
    const done = result.targets.filter((target) => target.status === 'succeeded').length;
    message.textContent = `${result.status === 'running' ? 'Approving' : 'Approval batch ' + result.status}: ${done} of ${result.targets.length} approved.`
      + (result.error ? ` ${result.error}` : '')
      + (result.refreshError ? ` Refresh failed: ${result.refreshError}` : '')
      + (result.targets.some((target) => target.status === 'uncertain')
        ? ' Some outcomes are uncertain. Check GitHub before rechecking or retrying.' : '');
    document.getElementById('approval-select-label').hidden = true;
    document.getElementById('approval-count').textContent = '';
    submit.hidden = true;
    retry.hidden = busy || result.targets.every((target) => target.status === 'succeeded');
    newSelection.hidden = false;
    newSelection.disabled = busy;
    dismiss.hidden = busy;
    dismiss.disabled = false;
    document.getElementById('approval-close').textContent = 'Close';
  }

  async function prepare(targets) {
    const current = ++generation;
    preparationId = crypto.randomUUID();
    processed = 0;
    busy = true;
    selection = null;
    batch = null;
    submit.hidden = false;
    submit.disabled = true;
    retry.hidden = true;
    newSelection.hidden = true;
    dismiss.hidden = true;
    all.checked = false;
    all.indeterminate = false;
    all.disabled = true;
    document.getElementById('approval-select-label').hidden = false;
    document.getElementById('approval-count').textContent = '';
    document.getElementById('approval-close').textContent = 'Cancel';
    renderApprovalRows(list, targets.map((target) => ({
      ...target,
      author: typeof target.author === 'string' ? target.author : target.author && target.author.login,
      eligible: false, reason: 'Checking eligibility...'
    })));
    message.textContent = `Checking your identity and existing approvals... (0 of ${targets.length} PRs processed)`;
    try {
      if (!targets.length) {
        message.textContent = 'No pull requests match the current filter.';
        return;
      }
      const result = await request('prepare-approvals', { targets, preparationId });
      if (current !== generation) return;
      selection = result;
      renderApprovalRows(list, selection.candidates);
      message.textContent = `Approving as ${selection.login}. Select the PRs to approve.`;
      updateApprovalSelection(dialog);
    } catch (error) {
      if (current === generation) message.textContent = `Unable to prepare approvals: ${error.message}`;
    } finally {
      if (current === generation) {
        busy = false;
        preparationId = null;
      }
    }
  }

  async function prepareVisible() {
    const [settings, state, stored] = await Promise.all([loadSettings(), loadState(), chrome.storage.local.get(FILTER_KEY)]);
    if (dialog.open) await prepare(visiblePullRequests({ settings, state, filter: stored[FILTER_KEY] || FILTER_ALL }));
  }

  opener.innerHTML = ICONS.check;
  opener.addEventListener('click', async () => {
    if (dialog.open) return;
    const current = ++generation;
    selection = null;
    batch = null;
    list.replaceChildren();
    document.getElementById('approval-select-label').hidden = true;
    document.getElementById('approval-count').textContent = '';
    document.body.classList.add('approvals-open');
    dialog.showModal();
    message.textContent = 'Loading approval status...';
    submit.disabled = true;
    retry.hidden = true;
    newSelection.hidden = true;
    dismiss.hidden = true;
    busy = true;
    try {
      const previous = await request('approval-status');
      if (!dialog.open || current !== generation) return;
      if (previous) {
        showBatch(previous);
        return;
      }
      await prepareVisible();
    } catch (error) {
      if (dialog.open && current === generation) {
        message.textContent = `Unable to load approval status: ${error.message}`;
        busy = false;
      }
    }
  });
  async function dismissResults(result, button) {
    button.disabled = true;
    try {
      await request('dismiss-approvals', { batchId: result.id });
      const status = document.getElementById('status');
      if (status.dataset.approvalBatchId === result.id) {
        status.replaceChildren();
        status.hidden = true;
        delete status.dataset.approvalBatchId;
      }
      if (batch && batch.id === result.id) {
        batch = null;
        if (dialog.open) dialog.close();
      }
    } catch (error) {
      if (dialog.open) message.textContent = `Unable to dismiss results: ${error.message}`;
      else showStatus(document.getElementById('status'), `Unable to dismiss results: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }
  dismiss.addEventListener('click', () => {
    if (!busy && batch) dismissResults(batch, dismiss);
  });
  // A completed result remains visible until explicitly replaced by a fresh selection.
  retry.addEventListener('click', () => {
    if (!busy && batch) prepare(batch.targets.filter((target) => target.status !== 'succeeded'));
  });
  newSelection.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    newSelection.disabled = true;
    try {
      await prepareVisible();
    } catch (error) {
      message.textContent = `Unable to prepare approvals: ${error.message}`;
      busy = false;
      newSelection.disabled = false;
    }
  });
  document.getElementById('approval-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    generation++;
    preparationId = null;
    document.body.classList.remove('approvals-open');
    opener.focus();
  });
  all.addEventListener('change', () => {
    if (busy) return;
    for (const input of list.querySelectorAll('input:not(:disabled)')) input.checked = all.checked;
    updateApprovalSelection(dialog);
  });
  list.addEventListener('change', () => { if (!busy) updateApprovalSelection(dialog); });
  submit.addEventListener('click', async () => {
    if (busy || !selection) return;
    const targets = [...list.querySelectorAll('input:checked:not(:disabled)')]
      .map((input) => selection.candidates[Number(input.dataset.index)])
      .map(({ repo, number }) => ({ repo, number }));
    if (!targets.length) return;
    busy = true;
    submit.disabled = true;
    all.disabled = true;
    for (const input of list.querySelectorAll('input')) input.disabled = true;
    message.textContent = 'Submitting approvals...';
    try {
      showBatch(await request('submit-approvals', { selectionId: selection.id, targets }));
    } catch (error) {
      message.textContent = `Submission could not be confirmed: ${error.message}. Close and reopen to check saved results before retrying.`;
      // Do not re-enable submission after an ambiguous messaging failure.
      busy = false;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const progress = changes[APPROVAL_PREPARATION_KEY] && changes[APPROVAL_PREPARATION_KEY].newValue;
    if (area === 'local' && dialog.open && preparationId && progress && progress.id === preparationId) {
      processed = Math.max(processed, progress.processed);
      message.textContent = `Checking approvals: ${processed} of ${progress.total} PRs processed...`;
    }
    const result = changes[APPROVAL_BATCH_KEY] && changes[APPROVAL_BATCH_KEY].newValue;
    if (area === 'local' && result && !result.dismissed && dialog.open
        && ((selection && result.selectionId === selection.id) || (batch && batch.id === result.id))) showBatch(result);
  });
  return async () => {
    try {
      const previous = await request('approval-status');
      if (previous) {
        batch = previous;
        const done = previous.targets.filter((target) => target.status === 'succeeded').length;
        showStatus(document.getElementById('status'),
          `Approval batch ${previous.status}: ${done}/${previous.targets.length} approved. Open Approve PRs for results.`, previous.status === 'interrupted');
        const status = document.getElementById('status');
        status.dataset.approvalBatchId = previous.id;
        if (previous.status !== 'running') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = 'Dismiss results';
          button.addEventListener('click', () => dismissResults(previous, button));
          status.append(document.createTextNode(' '), button);
        }
      }
    } catch (error) {
      showStatus(document.getElementById('status'), `Unable to load approval results: ${error.message}`, true);
    }
  };
}

async function render() {
  const [settings, state, stored] = await Promise.all([loadSettings(), loadState(), chrome.storage.local.get(FILTER_KEY)]);
  const filter = stored[FILTER_KEY] || FILTER_ALL;
  const { total } = renderPopup(document.getElementById('content'), { settings, state, filter });
  document.getElementById('total').textContent = String(total);
  document.getElementById('last-updated').textContent = lastUpdatedText(state);
  document.getElementById('refresh').classList.toggle('spinning', Boolean(state.refreshing));
}

async function enableAutomerge() {
  const [settings, state, stored] = await Promise.all([loadSettings(), loadState(), chrome.storage.local.get(FILTER_KEY)]);
  const targets = visiblePullRequests({ settings, state, filter: stored[FILTER_KEY] || FILTER_ALL })
    .filter((pr) => pr.nodeId && !pr.automerge.rebase)
    .map((pr) => ({ repo: pr.repo, number: pr.number, nodeId: pr.nodeId, automerge: pr.automerge }));
  const status = document.getElementById('status');
  if (targets.length === 0) {
    showStatus(status, 'Every listed PR already has auto-merge (rebase) enabled.', false);
    return;
  }
  if (!window.confirm(`Enable auto-merge (rebase) on ${targets.length} pull request${targets.length === 1 ? '' : 's'}?`)) return;
  const button = document.getElementById('automerge-all');
  button.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'enable-automerge', targets });
    if (!res || !res.ok) showStatus(status, `Failed: ${(res && res.error) || 'no response'}`, true);
    else showStatus(status, `Auto-merge (rebase) enabled on ${res.done} PR${res.done === 1 ? '' : 's'}.`, res.failed.length > 0,
      res.failed.map((f) => `${f.repo.split('/')[1]}#${f.number}: ${f.error}`));
  } finally {
    button.disabled = false;
    await render();
  }
}

function showStatus(node, text, isError, details = []) {
  delete node.dataset.approvalBatchId;
  node.replaceChildren(document.createTextNode(text));
  if (details.length) {
    const list = document.createElement('ul');
    for (const d of details) {
      const li = document.createElement('li');
      li.textContent = d;
      list.append(li);
    }
    node.append(list);
  }
  node.className = isError ? 'status status-error' : 'status';
  node.hidden = false;
}

async function refresh() {
  document.getElementById('refresh').classList.add('spinning');
  try {
    await chrome.runtime.sendMessage({ type: 'refresh' });
  } finally {
    await render();
  }
}

export function initPopup() {
  const restoreApprovals = initApprovals();
  document.getElementById('logo').innerHTML = ICONS.github;
  document.getElementById('refresh').innerHTML = ICONS.sync;
  document.getElementById('automerge-all').innerHTML = ICONS.merge;
  document.getElementById('settings').innerHTML = ICONS.gear;

  document.getElementById('refresh').addEventListener('click', () => refresh());
  document.getElementById('automerge-all').addEventListener('click', () => enableAutomerge());
  document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('content').addEventListener('click', (event) => {
    if (event.target.closest('.open-options')) chrome.runtime.openOptionsPage();
    const tab = event.target.closest('.filter');
    if (tab) chrome.storage.local.set({ [FILTER_KEY]: tab.dataset.filter }).then(render);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[STATE_KEY] || changes[SETTINGS_KEY])) render();
  });
  // Keep the "age" of PRs and the last-updated text current while the popup stays open.
  setInterval(render, 60 * 1000);

  return Promise.all([render(), restoreApprovals()]);
}

if (typeof document !== 'undefined' && document.getElementById('content') && document.body.dataset.page === 'popup') {
  initPopup().catch((e) => console.error('GitHub PR Notifier popup', e));
}
