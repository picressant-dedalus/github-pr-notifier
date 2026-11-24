import { ICONS } from './icons.js';
import { FILTER_ALL, renderApprovalRows, updateApprovalSelection, visiblePullRequests } from './popup-view.js';
import { loadSettings, loadState } from './settings.js';

export function initAutomerge() {
  const $ = (name) => document.getElementById(`automerge-${name}`);
  const dialog = $('dialog');
  const opener = $('prs');
  let selection = null;
  let batch = null;
  let busy = false;
  let generation = 0;
  let preparationId = null;
  let processed = 0;
  const rows = (targets, results = false) => renderApprovalRows($('list'), targets, { results, prefix: 'automerge' });
  const updateSelection = () => updateApprovalSelection(dialog, 'automerge');

  async function request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response || !response.ok) throw new Error((response && response.error) || 'No response from worker');
    return response.result;
  }

  function showSummary(result) {
    const summary = $('summary');
    summary.replaceChildren();
    summary.hidden = !result;
    if (!result) return;
    const done = result.targets.filter((target) => target.status === 'succeeded').length;
    const errors = result.status === 'interrupted' || result.error || result.refreshError
      || result.targets.some((target) => ['failed', 'uncertain'].includes(target.status));
    summary.className = errors ? 'status status-error' : 'status';
    summary.append(document.createTextNode(`Auto-merge batch ${result.status}: ${done}/${result.targets.length} enabled. Open auto-merge for results. `));
    if (result.status !== 'running') {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'btn';
      dismiss.textContent = 'Dismiss results';
      dismiss.addEventListener('click', () => dismissResults(result, dismiss));
      summary.append(dismiss);
    }
  }

  function showBatch(result) {
    batch = result;
    selection = null;
    preparationId = null;
    busy = result.status === 'running';
    rows(result.targets, true);
    const done = result.targets.filter((target) => target.status === 'succeeded').length;
    const processed = result.targets.filter((target) => !['pending', 'running'].includes(target.status)).length;
    $('message').textContent = `Auto-merge batch ${result.status}: ${done} of ${result.targets.length} enabled (${processed} processed).`
      + (result.error ? ` ${result.error}` : '')
      + (result.refreshError ? ` Refresh failed: ${result.refreshError}` : '')
      + (result.targets.some((target) => target.status === 'uncertain') ? ' Some outcomes are uncertain. Check GitHub before rechecking or retrying.' : '');
    $('select-label').hidden = true;
    $('count').textContent = '';
    $('submit').hidden = true;
    $('retry').hidden = busy || result.targets.every((target) => target.status === 'succeeded');
    $('new').hidden = false;
    $('new').disabled = busy;
    $('dismiss').hidden = busy;
    $('dismiss').disabled = false;
    $('close').textContent = 'Close';
    showSummary(result);
  }

  async function prepare(targets) {
    const current = ++generation;
    preparationId = crypto.randomUUID();
    processed = 0;
    busy = true;
    selection = null;
    batch = null;
    $('submit').hidden = false;
    $('submit').disabled = true;
    $('retry').hidden = true;
    $('new').hidden = true;
    $('dismiss').hidden = true;
    $('select-all').checked = false;
    $('select-all').indeterminate = false;
    $('select-all').disabled = true;
    $('select-label').hidden = false;
    $('count').textContent = '';
    $('close').textContent = 'Cancel';
    rows(targets.map((target) => ({
      ...target, author: typeof target.author === 'string' ? target.author : target.author && target.author.login,
      eligible: false, reason: 'Checking eligibility...'
    })));
    $('message').textContent = `Checking auto-merge eligibility... (0 of ${targets.length} PRs processed)`;
    try {
      if (!targets.length) {
        $('message').textContent = 'No pull requests match the current filter.';
        return;
      }
      const result = await request('prepare-automerge', { targets, preparationId });
      if (current !== generation || !dialog.open) return;
      selection = result;
      rows(result.candidates);
      $('message').textContent = result.candidates.some((target) => target.eligible)
        ? 'Select the PRs to enable auto-merge (rebase).' : 'No eligible PRs. See the reasons below.';
      updateSelection();
    } catch (error) {
      if (current === generation) $('message').textContent = `Unable to prepare auto-merge: ${error.message}`;
    } finally {
      if (current === generation) {
        preparationId = null;
        busy = false;
      }
    }
  }

  async function prepareVisible() {
    const current = generation;
    const [settings, state, stored] = await Promise.all([loadSettings(), loadState(), chrome.storage.local.get('popupFilter')]);
    if (dialog.open && current === generation) {
      await prepare(visiblePullRequests({ settings, state, filter: stored.popupFilter || FILTER_ALL }));
    }
  }

  async function dismissResults(result, button) {
    button.disabled = true;
    try {
      await request('dismiss-automerge', { batchId: result.id });
      if (batch && batch.id === result.id) {
        batch = null;
        if (dialog.open) dialog.close();
      }
      showSummary(null);
    } catch (error) {
      if (dialog.open) $('message').textContent = `Unable to dismiss results: ${error.message}`;
      else $('summary').append(document.createTextNode(` Unable to dismiss results: ${error.message}`));
    } finally {
      button.disabled = false;
    }
  }

  opener.innerHTML = ICONS.merge;
  opener.addEventListener('click', async () => {
    if (dialog.open) return;
    const current = ++generation;
    busy = true;
    selection = null;
    batch = null;
    $('list').replaceChildren();
    $('select-label').hidden = true;
    $('count').textContent = '';
    $('submit').hidden = false;
    $('submit').disabled = true;
    for (const name of ['retry', 'new', 'dismiss']) $(name).hidden = true;
    $('close').textContent = 'Cancel';
    $('message').textContent = 'Loading auto-merge status...';
    document.body.classList.add('automerge-open');
    dialog.showModal();
    try {
      const previous = await request('automerge-status');
      if (!dialog.open || current !== generation) return;
      if (previous) showBatch(previous);
      else await prepareVisible();
    } catch (error) {
      if (current === generation) {
        busy = false;
        $('message').textContent = `Unable to load auto-merge status: ${error.message}`;
      }
    }
  });
  $('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    generation++;
    preparationId = null;
    document.body.classList.remove('automerge-open');
    opener.focus();
  });
  $('select-all').addEventListener('change', () => {
    if (busy) return;
    for (const input of $('list').querySelectorAll('input:not(:disabled)')) input.checked = $('select-all').checked;
    updateSelection();
  });
  $('list').addEventListener('change', () => { if (!busy) updateSelection(); });
  $('retry').addEventListener('click', () => {
    if (!busy && batch) prepare(batch.targets.filter((target) => target.status !== 'succeeded'));
  });
  $('new').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('new').disabled = true;
    try {
      await prepareVisible();
    } catch (error) {
      $('message').textContent = `Unable to prepare auto-merge: ${error.message}`;
      busy = false;
      $('new').disabled = false;
    }
  });
  $('dismiss').addEventListener('click', () => { if (!busy && batch) dismissResults(batch, $('dismiss')); });
  $('submit').addEventListener('click', async () => {
    if (busy || !selection) return;
    const targets = [...$('list').querySelectorAll('input:checked:not(:disabled)')]
      .map((input) => selection.candidates[Number(input.dataset.index)])
      .map(({ repo, number }) => ({ repo, number }));
    if (!targets.length) return;
    const current = generation;
    const selectionId = selection.id;
    busy = true;
    $('submit').disabled = true;
    $('select-all').disabled = true;
    for (const input of $('list').querySelectorAll('input')) input.disabled = true;
    $('message').textContent = 'Submitting auto-merge...';
    try {
      const result = await request('submit-automerge', { selectionId, targets });
      showSummary(result);
      if (dialog.open && current === generation) showBatch(result);
    } catch (error) {
      if (current === generation) {
        $('message').textContent = `Submission could not be confirmed: ${error.message}. Close and reopen to check saved results before retrying.`;
      }
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const progress = changes.automergePreparation && changes.automergePreparation.newValue;
    if (dialog.open && preparationId && progress && progress.id === preparationId) {
      processed = Math.max(processed, progress.processed);
      $('message').textContent = `Checking auto-merge: ${processed} of ${progress.total} PRs processed...`;
    }
    if (!changes.automergeBatch) return;
    const result = changes.automergeBatch.newValue;
    showSummary(result && !result.dismissed ? result : null);
    if (result && !result.dismissed && dialog.open
        && ((selection && result.selectionId === selection.id) || (batch && batch.id === result.id))) showBatch(result);
  });
  return async () => {
    try {
      showSummary(await request('automerge-status'));
    } catch (error) {
      $('summary').hidden = false;
      $('summary').textContent = `Unable to load auto-merge results: ${error.message}`;
      $('summary').className = 'status status-error';
    }
  };
}
