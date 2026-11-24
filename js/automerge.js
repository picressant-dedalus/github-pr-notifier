// Worker-owned auto-merge selections and outcomes, independent of refresh and approval state.
import { enableAutoMergeRebase, fetchAutomergeCandidate, GitHubError } from './github.js';
import { refreshAll } from './poller.js';
import { loadSettings, loadState } from './settings.js';

export const AUTOMERGE_BATCH_KEY = 'automergeBatch';
export const AUTOMERGE_SELECTION_KEY = 'automergeSelection';
let inFlight = null;
let preparation = null;
const key = (target) => `${target.repo.toLowerCase()}#${target.number}`;
const saveBatch = (batch) => chrome.storage.local.set({ [AUTOMERGE_BATCH_KEY]: batch });
const switchWarning = 'The previous auto-merge method may have been disabled. Check GitHub before retrying.';
const switchDetail = (target) => ['disabling', 'enabling-after-disable'].includes(target.stage) ? ` ${switchWarning}` : '';

function validateTargets(targets, settings) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('No pull requests selected');
  const repos = new Map(settings.repos.map((repo) => [repo.toLowerCase(), repo]));
  const unique = new Map();
  for (const target of targets) {
    if (!target || typeof target.repo !== 'string' || !repos.has(target.repo.toLowerCase())
        || !Number.isSafeInteger(target.number) || target.number <= 0) {
      throw new Error('Invalid pull request or repository is not configured');
    }
    const clean = { repo: repos.get(target.repo.toLowerCase()), number: target.number };
    unique.set(key(clean), clean);
  }
  return [...unique.values()];
}

async function checkCandidate(token, target) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetchAutomergeCandidate(token, target, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('GitHub check timed out after 20 seconds; try again'));
          controller.abort();
        }, 20000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadAutomergeBatch() {
  const stored = await chrome.storage.local.get(AUTOMERGE_BATCH_KEY);
  const batch = stored[AUTOMERGE_BATCH_KEY] || null;
  if (batch && batch.status === 'running' && !inFlight) {
    batch.status = 'interrupted';
    for (const target of batch.targets) {
      if (target.status === 'running') {
        target.status = 'uncertain';
        target.error = `Worker interrupted; check GitHub before retrying.${switchDetail(target)}`;
      } else if (target.status === 'pending') {
        target.status = 'skipped';
        target.error = 'Not submitted: worker interrupted';
      }
    }
    await saveBatch(batch);
  }
  return batch && !batch.dismissed ? batch : null;
}

export async function dismissAutomergeBatch(batchId) {
  if (inFlight) throw new Error('An auto-merge batch is still running');
  const batch = await loadAutomergeBatch();
  if (!batch || batch.id !== batchId) throw new Error('Auto-merge results changed; reopen the dialog');
  await saveBatch({ ...batch, dismissed: true });
}

export function prepareAutomerge(targets, onProgress = async () => {}) {
  if (inFlight || preparation) return Promise.reject(new Error('An auto-merge operation is already running'));
  preparation = doPrepare(targets, onProgress).finally(() => { preparation = null; });
  return preparation;
}

async function doPrepare(targets, onProgress) {
  await loadAutomergeBatch();
  const settings = await loadSettings();
  if (!settings.token) throw new Error('No GitHub token configured');
  const clean = validateTargets(targets, settings);
  const state = await loadState();
  const candidates = new Array(clean.length);
  let next = 0;
  let processed = 0;
  await onProgress({ processed, total: clean.length });
  async function checkNext() {
    while (next < clean.length) {
      const index = next++;
      const target = clean[index];
      try {
        candidates[index] = await checkCandidate(settings.token, target);
      } catch (error) {
        const cached = ((state.repos && state.repos[target.repo] || {}).pullRequests || [])
          .find((pr) => pr.number === target.number);
        candidates[index] = {
          ...target, title: cached ? cached.title : '', url: cached ? cached.url : '',
          author: cached && cached.author ? cached.author.login : '',
          baseRefName: cached ? cached.baseRefName : '',
          eligible: false, reason: `Unable to check: ${error.message}`
        };
      }
      await onProgress({ processed: ++processed, total: clean.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, clean.length) }, checkNext));
  const selection = { id: crypto.randomUUID(), candidates };
  await chrome.storage.local.set({ [AUTOMERGE_SELECTION_KEY]: selection });
  return selection;
}

export function submitAutomerge(selectionId, targets) {
  if (inFlight || preparation) return Promise.reject(new Error('An auto-merge operation is already running'));
  inFlight = runBatch(selectionId, targets).finally(() => { inFlight = null; });
  return inFlight;
}

async function runBatch(selectionId, targets) {
  const settings = await loadSettings();
  if (!settings.token) throw new Error('No GitHub token configured');
  const clean = validateTargets(targets, settings);
  const stored = await chrome.storage.local.get(AUTOMERGE_SELECTION_KEY);
  const selection = stored[AUTOMERGE_SELECTION_KEY];
  if (!selection || selection.id !== selectionId || selection.submitted) {
    throw new Error('Selection expired or already submitted; reopen the auto-merge dialog');
  }
  const candidates = new Map(selection.candidates.map((candidate) => [key(candidate), candidate]));
  const batch = {
    id: crypto.randomUUID(), selectionId, status: 'running',
    targets: clean.map((target) => {
      const candidate = candidates.get(key(target));
      if (!candidate || !candidate.eligible) throw new Error('Selected PR is not eligible; reopen the auto-merge dialog');
      return { ...candidate, status: 'pending' };
    })
  };
  await chrome.storage.local.set({
    [AUTOMERGE_BATCH_KEY]: batch,
    [AUTOMERGE_SELECTION_KEY]: { ...selection, submitted: true }
  });
  try {
    for (const target of batch.targets) {
      let fresh;
      try {
        const current = await loadSettings();
        if (current.token !== settings.token || !current.repos.includes(target.repo)) {
          throw new Error('Settings changed; reopen the auto-merge dialog');
        }
        fresh = await checkCandidate(settings.token, target);
        if (!fresh.eligible) {
          target.status = 'skipped';
          target.error = fresh.reason;
          await saveBatch(batch);
          continue;
        }
        if (fresh.nodeId !== target.nodeId) throw new Error('Pull request identity changed; reopen the auto-merge dialog');
      } catch (error) {
        target.status = 'failed';
        target.error = `Unable to recheck: ${error.message}`;
        await saveBatch(batch);
        continue;
      }
      target.status = 'running';
      await saveBatch(batch);
      // Separate stage persistence failures from API failures: no next mutation after a failed save.
      let storageError;
      try {
        await enableAutoMergeRebase(settings.token, fresh, async (stage) => {
          target.stage = stage;
          try {
            await saveBatch(batch);
          } catch (error) {
            storageError = error;
            throw error;
          }
        });
        target.status = 'succeeded';
      } catch (error) {
        if (storageError) throw storageError;
        target.status = error instanceof GitHubError && (error.rejected || (error.status >= 400 && error.status < 500 && error.status !== 408))
          ? 'failed' : 'uncertain';
        target.error = error.message + switchDetail(target);
      }
      await saveBatch(batch);
    }
    batch.status = 'completed';
    await saveBatch(batch);
  } catch (error) {
    batch.status = 'interrupted';
    batch.error = error.message;
    for (const target of batch.targets) {
      if (target.status === 'running') {
        target.status = 'uncertain';
        target.error = `Processing interrupted; check GitHub before retrying.${switchDetail(target)}`;
      } else if (target.status === 'pending') target.status = 'skipped';
    }
    await saveBatch(batch);
    throw error;
  }
  try {
    await refreshAll();
  } catch (error) {
    batch.refreshError = error.message;
    await saveBatch(batch);
  }
  return batch;
}
