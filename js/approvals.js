// Worker-owned approvals. Separate storage prevents refreshes from overwriting batch outcomes.
import { approvePullRequest, fetchApprovalCandidate, GitHubError, testToken } from './github.js';
import { refreshAll } from './poller.js';
import { loadSettings, loadState } from './settings.js';

export const APPROVAL_BATCH_KEY = 'approvalBatch';
export const APPROVAL_SELECTION_KEY = 'approvalSelection';
let inFlight = null;

const key = (target) => `${target.repo.toLowerCase()}#${target.number}`;
const saveBatch = (batch) => chrome.storage.local.set({ [APPROVAL_BATCH_KEY]: batch });

function validateTargets(targets, settings) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('No pull requests selected');
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

/** A stopped worker cannot safely replay a review whose HTTP response may have been lost. */
export async function loadApprovalBatch() {
  const stored = await chrome.storage.local.get(APPROVAL_BATCH_KEY);
  const batch = stored[APPROVAL_BATCH_KEY] || null;
  if (batch && batch.status === 'running' && !inFlight) {
    batch.status = 'interrupted';
    for (const target of batch.targets) {
      if (target.status === 'running') {
        target.status = 'uncertain';
        target.error = 'Worker interrupted; check GitHub before retrying';
      } else if (target.status === 'pending') {
        target.status = 'skipped';
        target.error = 'Not submitted: worker interrupted';
      }
    }
    await saveBatch(batch);
  }
  return batch;
}

export async function prepareApprovals(targets) {
  if (inFlight) throw new Error('An approval batch is already running');
  await loadApprovalBatch();
  const settings = await loadSettings();
  if (!settings.token) throw new Error('No GitHub token configured');
  const clean = validateTargets(targets, settings);
  const { login } = await testToken(settings.token);
  const state = await loadState();
  const candidates = [];
  for (const target of clean) {
    try {
      candidates.push(await fetchApprovalCandidate(settings.token, target, login));
    } catch (error) {
      const repo = state.repos && state.repos[target.repo];
      const cached = repo && (repo.pullRequests || []).find((pr) => pr.number === target.number);
      candidates.push({
        ...target, title: cached ? cached.title : '', url: cached ? cached.url : '',
        author: cached && cached.author ? cached.author.login : '',
        baseRefName: cached ? cached.baseRefName : '',
        eligible: false, reason: `Unable to check: ${error.message}`
      });
    }
  }
  const selection = { id: crypto.randomUUID(), login, candidates };
  await chrome.storage.local.set({ [APPROVAL_SELECTION_KEY]: selection });
  return selection;
}

/** Set the in-memory lock synchronously, before any async storage/API work. */
export function submitApprovals(selectionId, targets) {
  if (inFlight) return Promise.reject(new Error('An approval batch is already running'));
  inFlight = runApprovals(selectionId, targets).finally(() => { inFlight = null; });
  return inFlight;
}

async function runApprovals(selectionId, targets) {
  const settings = await loadSettings();
  if (!settings.token) throw new Error('No GitHub token configured');
  const clean = validateTargets(targets, settings);
  const stored = await chrome.storage.local.get(APPROVAL_SELECTION_KEY);
  const selection = stored[APPROVAL_SELECTION_KEY];
  if (!selection || selection.id !== selectionId || selection.submitted) {
    throw new Error('Selection expired or already submitted; reopen the approval dialog');
  }
  const { login } = await testToken(settings.token);
  if (login.toLowerCase() !== selection.login.toLowerCase()) throw new Error('Token user changed; reopen the approval dialog');
  const candidates = new Map(selection.candidates.map((candidate) => [key(candidate), candidate]));
  const batch = {
    id: crypto.randomUUID(), selectionId, status: 'running',
    targets: clean.map((target) => {
      const candidate = candidates.get(key(target));
      if (!candidate || !candidate.eligible) throw new Error('Selected PR is not eligible; reopen the approval dialog');
      return { ...candidate, status: 'pending' };
    })
  };
  await chrome.storage.local.set({
    [APPROVAL_BATCH_KEY]: batch,
    [APPROVAL_SELECTION_KEY]: { ...selection, submitted: true }
  });
  try {
    for (const target of batch.targets) {
      try {
        const currentSettings = await loadSettings();
        if (currentSettings.token !== settings.token || !currentSettings.repos.includes(target.repo)) {
          throw new Error('Settings changed; reopen the approval dialog');
        }
        const fresh = await fetchApprovalCandidate(settings.token, target, login);
        if (!fresh.eligible || fresh.headSha !== target.headSha) {
          target.status = 'skipped';
          target.error = fresh.eligible ? 'Head commit changed; reopen the dialog to review the new commit' : fresh.reason;
          await saveBatch(batch);
          continue;
        }
      } catch (error) {
        target.status = 'failed';
        target.error = `Unable to recheck: ${error.message}`;
        await saveBatch(batch);
        continue;
      }
      target.status = 'running';
      await saveBatch(batch);
      try {
        await approvePullRequest(settings.token, target);
        target.status = 'succeeded';
      } catch (error) {
        // A network/5xx failure may occur after GitHub has accepted the write.
        target.status = error instanceof GitHubError && error.status < 500 ? 'failed' : 'uncertain';
        target.error = error.message;
      }
      await saveBatch(batch);
    }
    batch.status = 'completed';
    await saveBatch(batch);
  } catch (error) {
    batch.status = 'interrupted';
    batch.error = error.message;
    for (const target of batch.targets) {
      if (target.status === 'running') target.status = 'uncertain';
      else if (target.status === 'pending') target.status = 'skipped';
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
