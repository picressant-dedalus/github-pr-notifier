import { AUTOMERGE_BATCH_KEY, AUTOMERGE_SELECTION_KEY, dismissAutomergeBatch, loadAutomergeBatch, prepareAutomerge, submitAutomerge } from '../js/automerge.js';
import { enableAutoMergeRebase, fetchAutomergeCandidate, GitHubError } from '../js/github.js';
import { refreshAll } from '../js/poller.js';
import { saveSettings } from '../js/settings.js';

jest.mock('../js/github.js', () => ({
  ...jest.requireActual('../js/github.js'),
  enableAutoMergeRebase: jest.fn(), fetchAutomergeCandidate: jest.fn()
}));
jest.mock('../js/poller.js', () => ({ refreshAll: jest.fn() }));
const target = (number = 1) => ({ repo: 'o/r', number });
const candidate = (number = 1) => ({
  ...target(number), nodeId: `node${number}`, eligible: true, title: 'PR',
  automerge: { enabled: false, rebase: false }, reason: ''
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

beforeEach(async () => {
  jest.clearAllMocks();
  crypto.randomUUID = jest.fn(() => `id-${++nextId}`);
  await saveSettings({ token: 't', repos: ['o/r'] });
  fetchAutomergeCandidate.mockImplementation(async (_token, value) => candidate(value.number));
  enableAutoMergeRebase.mockImplementation(async (_token, value, stage) => { await stage('enabling'); });
  refreshAll.mockResolvedValue();
});

it('deduplicates configured targets, keeps disabled rows and reports failed checks', async () => {
  fetchAutomergeCandidate.mockResolvedValueOnce({ ...candidate(), eligible: false, reason: 'Already rebase' })
    .mockRejectedValueOnce(new Error('No access'));
  const progress = jest.fn(async () => {});
  const selection = await prepareAutomerge([target(), { repo: 'O/R', number: 1 }, target(2), target(3)], progress);
  expect(selection.candidates).toMatchObject([
    { eligible: false, reason: 'Already rebase' },
    { eligible: false, reason: 'Unable to check: No access' },
    { eligible: true }
  ]);
  expect(progress.mock.calls.map(([value]) => value.processed)).toEqual([0, 1, 2, 3]);
  expect(enableAutoMergeRebase).not.toHaveBeenCalled();
});

it('rejects invalid targets and missing configuration', async () => {
  await expect(prepareAutomerge([])).rejects.toThrow('No pull requests');
  await expect(prepareAutomerge([{ repo: 'elsewhere/r', number: 1 }])).rejects.toThrow('not configured');
  await expect(prepareAutomerge([target(-1)])).rejects.toThrow('Invalid');
  await saveSettings({ token: '', repos: ['o/r'] });
  await expect(prepareAutomerge([target()])).rejects.toThrow('No GitHub token');
});

it('bounds concurrent checks and preserves order', async () => {
  const releases = [];
  fetchAutomergeCandidate.mockImplementation((_token, value) => new Promise((resolve) => {
    releases.push(() => resolve(candidate(value.number)));
  }));
  const pending = prepareAutomerge(Array.from({ length: 5 }, (_, i) => target(i + 1)));
  await tick();
  expect(fetchAutomergeCandidate).toHaveBeenCalledTimes(4);
  await expect(prepareAutomerge([target()])).rejects.toThrow('already running');
  await expect(submitAutomerge('old', [target()])).rejects.toThrow('already running');
  releases.splice(0).reverse().forEach((release) => release());
  await tick();
  releases.forEach((release) => release());
  expect((await pending).candidates.map((value) => value.number)).toEqual([1, 2, 3, 4, 5]);
});

it('times out checks and aborts their requests without writing', async () => {
  jest.useFakeTimers();
  let signal;
  fetchAutomergeCandidate.mockImplementation((_token, _target, value) => {
    signal = value;
    return new Promise(() => {});
  });
  try {
    const pending = prepareAutomerge([target()]);
    await jest.advanceTimersByTimeAsync(20000);
    expect((await pending).candidates[0]).toMatchObject({ eligible: false, reason: expect.stringContaining('timed out') });
    expect(signal.aborted).toBe(true);
    expect(enableAutoMergeRebase).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('writes only selected eligible identities and never replays a selection', async () => {
  const selection = await prepareAutomerge([target(), target(2)]);
  await expect(submitAutomerge('expired', [target()])).rejects.toThrow('expired');
  await expect(submitAutomerge(selection.id, [target(3)])).rejects.toThrow('not eligible');
  const batch = await submitAutomerge(selection.id, [target(2)]);
  expect(enableAutoMergeRebase).toHaveBeenCalledTimes(1);
  expect(enableAutoMergeRebase).toHaveBeenCalledWith('t', candidate(2), expect.any(Function));
  expect(batch.targets).toMatchObject([{ number: 2, status: 'succeeded' }]);
  expect(await loadAutomergeBatch()).toEqual(batch);
  expect(refreshAll).toHaveBeenCalledTimes(1);
  await expect(submitAutomerge(selection.id, [target()])).rejects.toThrow('already submitted');
  expect(chrome._store()[AUTOMERGE_SELECTION_KEY].submitted).toBe(true);
});

it('rejects a disabled prepared row', async () => {
  fetchAutomergeCandidate.mockResolvedValueOnce({ ...candidate(), eligible: false, reason: 'Missing ID' });
  const selection = await prepareAutomerge([target()]);
  await expect(submitAutomerge(selection.id, [target()])).rejects.toThrow('not eligible');
  expect(enableAutoMergeRebase).not.toHaveBeenCalled();
});

it('persists running and stage before writes, rejects overlap and continues without popup messages', async () => {
  const selection = await prepareAutomerge([target()]);
  let release;
  enableAutoMergeRebase.mockImplementation(async (_token, _value, stage) => {
    expect(chrome._store()[AUTOMERGE_BATCH_KEY].targets[0].status).toBe('running');
    await stage('enabling');
    expect(chrome._store()[AUTOMERGE_BATCH_KEY].targets[0].stage).toBe('enabling');
    await new Promise((resolve) => { release = resolve; });
  });
  const pending = submitAutomerge(selection.id, [target()]);
  await tick();
  await expect(submitAutomerge(selection.id, [target()])).rejects.toThrow('already running');
  await expect(prepareAutomerge([target()])).rejects.toThrow('already running');
  await expect(dismissAutomergeBatch('anything')).rejects.toThrow('still running');
  expect((await loadAutomergeBatch()).status).toBe('running');
  release();
  expect((await pending).targets[0].status).toBe('succeeded');
});

it('freshly skips newly ineligible PRs and fails rechecks without writing', async () => {
  const selection = await prepareAutomerge([target(), target(2), target(3)]);
  fetchAutomergeCandidate.mockResolvedValueOnce({ ...candidate(), eligible: false, reason: 'Already rebase' })
    .mockResolvedValueOnce({ ...candidate(2), eligible: false, reason: 'Closed' })
    .mockRejectedValueOnce(new Error('No access'));
  const batch = await submitAutomerge(selection.id, [target(), target(2), target(3)]);
  expect(batch.targets.map((value) => value.status)).toEqual(['skipped', 'skipped', 'failed']);
  expect(enableAutoMergeRebase).not.toHaveBeenCalled();
});

it('detects settings changes during a batch and does not write further targets', async () => {
  const selection = await prepareAutomerge([target(), target(2)]);
  enableAutoMergeRebase.mockImplementationOnce(async () => { await saveSettings({ token: 'other', repos: ['o/r'] }); });
  const batch = await submitAutomerge(selection.id, [target(), target(2)]);
  expect(batch.targets.map((value) => value.status)).toEqual(['succeeded', 'failed']);
  expect(batch.targets[1].error).toContain('Settings changed');
  expect(enableAutoMergeRebase).toHaveBeenCalledTimes(1);
});

it('rejects a changed PR identity without writing to the replacement', async () => {
  const selection = await prepareAutomerge([target()]);
  fetchAutomergeCandidate.mockResolvedValueOnce({ ...candidate(), nodeId: 'replacement' });
  const batch = await submitAutomerge(selection.id, [target()]);
  expect(batch.targets[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('identity changed') });
  expect(enableAutoMergeRebase).not.toHaveBeenCalled();
});

it('keeps definite and uncertain outcomes and warns about partially switched methods', async () => {
  const targets = Array.from({ length: 5 }, (_, i) => target(i + 1));
  const selection = await prepareAutomerge(targets);
  enableAutoMergeRebase.mockImplementationOnce(async (_token, _value, stage) => {
    await stage('enabling-after-disable');
    throw new GitHubError('Forbidden', 403);
  }).mockRejectedValueOnce(new Error('Connection lost'))
    .mockRejectedValueOnce(new GitHubError('Unavailable', 503))
    .mockRejectedValueOnce(new GitHubError('Not allowed', undefined, true));
  const batch = await submitAutomerge(selection.id, targets);
  expect(batch.targets.map((value) => value.status)).toEqual(['failed', 'uncertain', 'uncertain', 'failed', 'succeeded']);
  expect(batch.targets[0].error).toContain('previous auto-merge method may have been disabled');
  expect(await loadAutomergeBatch()).toEqual(batch);
});

it('keeps outcomes when refresh fails and dismisses only the requested batch', async () => {
  const selection = await prepareAutomerge([target()]);
  refreshAll.mockRejectedValueOnce(new Error('Storage unavailable'));
  const batch = await submitAutomerge(selection.id, [target()]);
  expect(batch.targets[0].status).toBe('succeeded');
  expect(batch.refreshError).toBe('Storage unavailable');
  await expect(dismissAutomergeBatch('other')).rejects.toThrow('results changed');
  await dismissAutomergeBatch(batch.id);
  expect(await loadAutomergeBatch()).toBeNull();
  await expect(submitAutomerge(selection.id, [target()])).rejects.toThrow('already submitted');
});

it('recovers interrupted switches as uncertain without automatic replay and rechecks fresh state', async () => {
  await chrome.storage.local.set({ [AUTOMERGE_BATCH_KEY]: {
    id: 'old', status: 'running', targets: [
      { ...candidate(), status: 'succeeded' },
      { ...candidate(2), status: 'running', stage: 'enabling-after-disable' },
      { ...candidate(3), status: 'pending' }
    ]
  } });
  const batch = await loadAutomergeBatch();
  expect(batch.status).toBe('interrupted');
  expect(batch.targets.map((value) => value.status)).toEqual(['succeeded', 'uncertain', 'skipped']);
  expect(batch.targets[1].error).toContain('previous auto-merge method');
  expect(enableAutoMergeRebase).not.toHaveBeenCalled();
  fetchAutomergeCandidate.mockResolvedValueOnce({ ...candidate(2), eligible: false, reason: 'Already rebase' });
  const selection = await prepareAutomerge([target(2)]);
  expect(selection.candidates[0].eligible).toBe(false);
  expect(enableAutoMergeRebase).not.toHaveBeenCalled();
});

it('does not continue writes when saving a switch stage fails', async () => {
  const selection = await prepareAutomerge([target(), target(2)]);
  const save = chrome.storage.local.set.getMockImplementation();
  chrome.storage.local.set.mockImplementation(async (items) => {
    if (items.automergeBatch && items.automergeBatch.targets[0].stage === 'enabling-after-disable'
        && items.automergeBatch.status === 'running') throw new Error('Disk full');
    return save(items);
  });
  enableAutoMergeRebase.mockImplementationOnce(async (_token, _value, stage) => {
    await stage('enabling-after-disable');
  });
  await expect(submitAutomerge(selection.id, [target(), target(2)])).rejects.toThrow('Disk full');
  expect(enableAutoMergeRebase).toHaveBeenCalledTimes(1);
  expect((await loadAutomergeBatch()).targets.map((value) => value.status)).toEqual(['uncertain', 'skipped']);
});
