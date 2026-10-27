import { APPROVAL_BATCH_KEY, APPROVAL_SELECTION_KEY, dismissApprovalBatch, loadApprovalBatch, prepareApprovals, submitApprovals } from '../js/approvals.js';
import { approvePullRequest, fetchApprovalCandidate, GitHubError, testToken } from '../js/github.js';
import { refreshAll } from '../js/poller.js';
import { saveSettings } from '../js/settings.js';

jest.mock('../js/github.js', () => {
  const actual = jest.requireActual('../js/github.js');
  return { ...actual, approvePullRequest: jest.fn(), fetchApprovalCandidate: jest.fn(), testToken: jest.fn() };
});
jest.mock('../js/poller.js', () => ({ refreshAll: jest.fn() }));

const target = (number = 1) => ({ repo: 'o/r', number });
const candidate = (number = 1) => ({ ...target(number), eligible: true, headSha: `sha${number}`, title: 'A PR' });
let nextId = 0;

beforeEach(async () => {
  jest.clearAllMocks();
  crypto.randomUUID = jest.fn(() => `id-${++nextId}`);
  await saveSettings({ token: 't', repos: ['o/r'] });
  testToken.mockResolvedValue({ login: 'me' });
  fetchApprovalCandidate.mockImplementation(async (_token, value) => candidate(value.number));
  approvePullRequest.mockResolvedValue();
  refreshAll.mockResolvedValue();
});

it('deduplicates configured targets and records per-PR lookup failures', async () => {
  fetchApprovalCandidate.mockRejectedValueOnce(new Error('No access'));
  const selection = await prepareApprovals([target(), { repo: 'O/R', number: 1 }, target(2)]);
  expect(selection.candidates).toHaveLength(2);
  expect(selection.candidates[0]).toMatchObject({ eligible: false, reason: 'Unable to check: No access' });
  expect(selection.candidates[1].eligible).toBe(true);
  expect(testToken).toHaveBeenCalledTimes(1);
});

it('reports preparation progress for successful and failed checks', async () => {
  const progress = jest.fn(async () => {});
  fetchApprovalCandidate.mockRejectedValueOnce(new Error('No access'));
  await prepareApprovals([target(), target(2)], progress);
  expect(progress.mock.calls.map(([value]) => value)).toEqual([
    { processed: 0, total: 2 },
    { processed: 1, total: 2 },
    { processed: 2, total: 2 }
  ]);
});

it('checks multiple PRs concurrently with a bounded pool and preserves their order', async () => {
  const releases = [];
  fetchApprovalCandidate.mockImplementation((_token, value) => new Promise((resolve) => {
    releases.push(() => resolve(candidate(value.number)));
  }));
  const pending = prepareApprovals(Array.from({ length: 6 }, (_, index) => target(index + 1)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetchApprovalCandidate).toHaveBeenCalledTimes(4);
  releases.splice(0).reverse().forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetchApprovalCandidate).toHaveBeenCalledTimes(6);
  releases.forEach((release) => release());
  const selection = await pending;
  expect(selection.candidates.map((value) => value.number)).toEqual([1, 2, 3, 4, 5, 6]);
});

it.each(['identity', 'candidate'])('times out a stalled %s check and aborts its requests', async (stage) => {
  jest.useFakeTimers();
  let signal;
  const stalled = (...args) => {
    signal = args[args.length - 1];
    return new Promise(() => {});
  };
  if (stage === 'identity') testToken.mockImplementation(stalled);
  else fetchApprovalCandidate.mockImplementation(stalled);
  try {
    const pending = prepareApprovals([target()]);
    const outcome = stage === 'identity'
      ? expect(pending).rejects.toThrow('timed out')
      : expect(pending).resolves.toMatchObject({
        candidates: [{ eligible: false, reason: expect.stringContaining('timed out') }]
      });
    await jest.advanceTimersByTimeAsync(20000);
    await outcome;
    expect(signal.aborted).toBe(true);
    expect(approvePullRequest).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('rejects missing tokens, invalid targets and unconfigured repositories', async () => {
  await expect(prepareApprovals([{ repo: 'other/repo', number: 1 }])).rejects.toThrow('not configured');
  await expect(prepareApprovals([target(-1)])).rejects.toThrow('Invalid');
  await expect(prepareApprovals([])).rejects.toThrow('No pull requests');
  await saveSettings({ token: '', repos: ['o/r'] });
  await expect(prepareApprovals([target()])).rejects.toThrow('No GitHub token');
});

it('persists outcomes across a mixed batch and never replays the same selection', async () => {
  const selection = await prepareApprovals([target(), target(2), target(3)]);
  approvePullRequest.mockResolvedValueOnce()
    .mockRejectedValueOnce(new GitHubError('Forbidden', 403))
    .mockRejectedValueOnce(new Error('Connection lost'));
  const batch = await submitApprovals(selection.id, [target(), target(2), target(3)]);
  expect(batch.targets.map((value) => value.status)).toEqual(['succeeded', 'failed', 'uncertain']);
  expect(await loadApprovalBatch()).toEqual(batch);
  expect(refreshAll).toHaveBeenCalledTimes(1);
  await expect(submitApprovals(selection.id, [target(2)])).rejects.toThrow('already submitted');
  expect(approvePullRequest).toHaveBeenCalledTimes(3);
});

it('persistently dismisses only the requested batch without allowing its selection to replay', async () => {
  const selection = await prepareApprovals([target()]);
  const batch = await submitApprovals(selection.id, [target()]);
  await expect(dismissApprovalBatch('other')).rejects.toThrow('results changed');
  expect(await loadApprovalBatch()).toEqual(batch);
  await dismissApprovalBatch(batch.id);
  expect(await loadApprovalBatch()).toBeNull();
  expect(chrome._store()[APPROVAL_BATCH_KEY].dismissed).toBe(true);
  await expect(submitApprovals(selection.id, [target()])).rejects.toThrow('already submitted');
  const next = await prepareApprovals([target(2)]);
  const nextBatch = await submitApprovals(next.id, [target(2)]);
  expect(await loadApprovalBatch()).toEqual(nextBatch);
});

it('persists running before each write and rejects overlap', async () => {
  const selection = await prepareApprovals([target()]);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  approvePullRequest.mockImplementation(async () => {
    expect(chrome._store()[APPROVAL_BATCH_KEY].targets[0].status).toBe('running');
    await pending;
  });
  const first = submitApprovals(selection.id, [target()]);
  await expect(submitApprovals(selection.id, [target()])).rejects.toThrow('already running');
  await expect(prepareApprovals([target()])).rejects.toThrow('already running');
  await expect(dismissApprovalBatch('anything')).rejects.toThrow('still running');
  release();
  await first;
});

it('skips changed heads and newly ineligible PRs without writing', async () => {
  const selection = await prepareApprovals([target(), target(2)]);
  fetchApprovalCandidate.mockResolvedValueOnce({ ...candidate(), headSha: 'changed' })
    .mockResolvedValueOnce({ ...candidate(2), eligible: false, reason: 'Already approved by you' });
  const batch = await submitApprovals(selection.id, [target(), target(2)]);
  expect(batch.targets.map((value) => value.status)).toEqual(['skipped', 'skipped']);
  expect(batch.targets[0].error).toContain('Head commit changed');
  expect(approvePullRequest).not.toHaveBeenCalled();
});

it('rejects expired selections, disabled targets and changed token identities', async () => {
  const selection = await prepareApprovals([target()]);
  await expect(submitApprovals('expired', [target()])).rejects.toThrow('expired');
  await expect(submitApprovals(selection.id, [target(2)])).rejects.toThrow('not eligible');
  testToken.mockResolvedValue({ login: 'other' });
  await expect(submitApprovals(selection.id, [target()])).rejects.toThrow('Token user changed');
  expect(approvePullRequest).not.toHaveBeenCalled();
});

it('keeps success when the refresh fails', async () => {
  const selection = await prepareApprovals([target()]);
  refreshAll.mockRejectedValueOnce(new Error('Storage unavailable'));
  const batch = await submitApprovals(selection.id, [target()]);
  expect(batch.targets[0].status).toBe('succeeded');
  expect(batch.refreshError).toBe('Storage unavailable');
  expect(await loadApprovalBatch()).toEqual(batch);
});

it('marks abandoned writes uncertain and rechecks rather than replaying them', async () => {
  await chrome.storage.local.set({
    [APPROVAL_BATCH_KEY]: { id: 'old', status: 'running', targets: [
      { ...target(), status: 'succeeded' }, { ...target(2), status: 'running' }, { ...target(3), status: 'pending' }
    ] }
  });
  expect((await loadApprovalBatch()).targets.map((value) => value.status)).toEqual(['succeeded', 'uncertain', 'skipped']);
  expect(approvePullRequest).not.toHaveBeenCalled();
  fetchApprovalCandidate.mockResolvedValueOnce({ ...candidate(2), eligible: false, reason: 'Already approved by you' });
  const selection = await prepareApprovals([target(2), target(3)]);
  expect(selection.candidates[0].eligible).toBe(false);
  await expect(submitApprovals(selection.id, [target(2)])).rejects.toThrow('not eligible');
  expect(chrome._store()[APPROVAL_SELECTION_KEY].submitted).toBeUndefined();
});

it('records recheck failures without submitting and detects settings changes', async () => {
  const selection = await prepareApprovals([target(), target(2)]);
  fetchApprovalCandidate.mockRejectedValueOnce(new Error('API unavailable'));
  const batch = await submitApprovals(selection.id, [target(), target(2)]);
  expect(batch.targets.map((value) => value.status)).toEqual(['failed', 'succeeded']);
  const next = await prepareApprovals([target()]);
  await saveSettings({ token: 'replacement', repos: ['o/r'] });
  // The identity is unchanged, so this fresh submission may safely use the new credential.
  await expect(submitApprovals(next.id, [target()])).resolves.toMatchObject({ status: 'completed' });
});
