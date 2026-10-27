jest.mock('../js/approvals.js', () => ({
  loadApprovalBatch: jest.fn(),
  dismissApprovalBatch: jest.fn(),
  prepareApprovals: jest.fn(),
  submitApprovals: jest.fn()
}));
jest.mock('../js/poller.js', () => ({
  ALARM_NAME: 'refresh-pull-requests', refreshAll: jest.fn(async () => {}),
  scheduleRefresh: jest.fn(async () => {}), updateBadge: jest.fn(async () => {})
}));

it('routes approval messages and returns async success/failure responses', async () => {
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
});
