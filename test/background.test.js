jest.mock('../js/approvals.js', () => ({
  loadApprovalBatch: jest.fn(),
  dismissApprovalBatch: jest.fn(),
  prepareApprovals: jest.fn(),
  submitApprovals: jest.fn()
}));
jest.mock('../js/automerge.js', () => ({
  loadAutomergeBatch: jest.fn(), dismissAutomergeBatch: jest.fn(),
  prepareAutomerge: jest.fn(), submitAutomerge: jest.fn()
}));
jest.mock('../js/poller.js', () => ({
  ALARM_NAME: 'refresh-pull-requests', refreshAll: jest.fn(async () => {}),
  scheduleRefresh: jest.fn(async () => {}), updateBadge: jest.fn(async () => {})
}));

it('routes approval and auto-merge messages and returns async success/failure responses', async () => {
  const { dismissApprovalBatch, loadApprovalBatch, prepareApprovals, submitApprovals } = require('../js/approvals.js');
  require('../js/background.js');
  const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  const targets = [{ repo: 'o/r', number: 1 }];
  const sendResponse = jest.fn();
  loadApprovalBatch.mockResolvedValueOnce(null);
  prepareApprovals.mockResolvedValueOnce({ id: 'selection' });
  submitApprovals.mockRejectedValueOnce(new Error('Not eligible'));
  expect(handler({ type: 'approval-status' }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, result: null });
  expect(handler({ type: 'prepare-approvals', targets, preparationId: 'preparation' }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  expect(prepareApprovals).toHaveBeenCalledWith(targets, expect.any(Function));
  const reportProgress = prepareApprovals.mock.calls[0][1];
  await reportProgress({ processed: 1, total: 2 });
  expect(chrome._store().approvalPreparation).toEqual({ id: 'preparation', processed: 1, total: 2 });
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, result: { id: 'selection' } });
  expect(handler({ type: 'submit-approvals', selectionId: 'selection', targets }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(submitApprovals).toHaveBeenCalledWith('selection', targets);
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: false, error: 'Not eligible' });
  dismissApprovalBatch.mockResolvedValueOnce();
  expect(handler({ type: 'dismiss-approvals', batchId: 'batch' }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  expect(dismissApprovalBatch).toHaveBeenCalledWith('batch');
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, result: undefined });
  const { loadAutomergeBatch, dismissAutomergeBatch, prepareAutomerge, submitAutomerge } = require('../js/automerge.js');
  loadAutomergeBatch.mockResolvedValueOnce({ id: 'auto-batch' });
  expect(handler({ type: 'automerge-status' }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, result: { id: 'auto-batch' } });
  prepareAutomerge.mockResolvedValueOnce({ id: 'auto-selection' });
  expect(handler({ type: 'prepare-automerge', targets, preparationId: 'auto-preparation' }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  await prepareAutomerge.mock.calls[0][1]({ processed: 1, total: 2 });
  expect(chrome._store().automergePreparation).toEqual({ id: 'auto-preparation', processed: 1, total: 2 });
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, result: { id: 'auto-selection' } });
  submitAutomerge.mockResolvedValueOnce({ id: 'auto-batch', status: 'completed' });
  expect(handler({ type: 'submit-automerge', selectionId: 'auto-selection', targets }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  expect(submitAutomerge).toHaveBeenCalledWith('auto-selection', targets);
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: true, result: { id: 'auto-batch', status: 'completed' } });
  dismissAutomergeBatch.mockRejectedValueOnce(new Error('Still running'));
  expect(handler({ type: 'dismiss-automerge', batchId: 'auto-batch' }, {}, sendResponse)).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(dismissAutomergeBatch).toHaveBeenCalledWith('auto-batch');
  expect(sendResponse).toHaveBeenLastCalledWith({ ok: false, error: 'Still running' });
  expect(handler({ type: 'enable-automerge', targets }, {}, sendResponse)).toBe(false);
});
