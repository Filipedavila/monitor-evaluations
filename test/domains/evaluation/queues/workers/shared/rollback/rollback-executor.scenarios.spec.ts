import { createRollbackExecutor } from '@evaluation/queues/workers/shared/rollback/rollback-executor';
import type { StorageWrite } from '@evaluation/queues/workers/shared/rollback//rollback-state';
import {
  createDepsHarness,
  createJobHarness,
  createLoggerHarness,
  firstCallOrder,
} from 'test/helpers/worker-test-utils';

const write = (evaluationId: number, evaluationDate: string): StorageWrite => ({
  evaluationId,
  evaluationDate,
});

function setup(data: Parameters<typeof createJobHarness>[0] = {}) {
  const d = createDepsHarness();
  const h = createJobHarness(data);
  const l = createLoggerHarness();
  const rollback = createRollbackExecutor(d.deps, l.logger);
  return { d, h, l, rollback };
}

describe('createRollbackExecutor - scenarios', () => {
  it('undoes a complete journal: storage in reverse order, then the database record, then clears the journal', async () => {
    const { d, h, rollback } = setup({
      data: {
        evaluationId: 7,
        __rollback: {
          createdEvaluationId: 7,
          storageWrites: [write(7, '2024-05-10'), write(7, '2024-05-11'), write(7, '2024-05-12')],
        },
      },
    });

    await rollback(h.job);

    expect(d.storeDelete.mock.calls.map(([arg]) => arg.evaluationDate)).toEqual([
      '2024-05-12',
      '2024-05-11',
      '2024-05-10',
    ]);
    expect(d.storeDelete).toHaveBeenCalledWith({
      evaluationId: 7,
      websiteId: 5,
      pageId: 10,
      evaluationDate: '2024-05-10',
    });
    expect(d.repoDelete).toHaveBeenCalledTimes(1);
    expect(d.repoDelete).toHaveBeenCalledWith(7);
    expect(h.data.evaluationId).toBeUndefined();
    expect(h.data.__rollback).toBeUndefined();
  });

  it('removes storage files before the database record', async () => {
    const { d, h, rollback } = setup({
      data: { __rollback: { createdEvaluationId: 7, storageWrites: [write(7, '2024-05-10')] } },
    });

    await rollback(h.job);

    expect(firstCallOrder(d.storeDelete)).toBeLessThan(firstCallOrder(d.repoDelete));
  });

  it('only rolls back storage when the evaluation id came from the producer (re-evaluation)', async () => {
    const { d, h, rollback } = setup({
      data: { evaluationId: 77, __rollback: { storageWrites: [write(77, '2024-05-10')] } },
    });

    await rollback(h.job);

    expect(d.storeDelete).toHaveBeenCalledTimes(1);
    expect(d.repoDelete).not.toHaveBeenCalled();
    expect(h.data.evaluationId).toBe(77);
    expect(h.data.__rollback).toBeUndefined();
  });

  it('only removes the database record when no storage write was journaled', async () => {
    const { d, h, rollback } = setup({
      data: { evaluationId: 7, __rollback: { createdEvaluationId: 7 } },
    });

    await rollback(h.job);

    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.repoDelete).toHaveBeenCalledWith(7);
    expect(h.data.evaluationId).toBeUndefined();
  });

  it('keeps the evaluation id and journals only the record when the database delete fails', async () => {
    const { d, h, rollback } = setup({
      data: {
        evaluationId: 7,
        __rollback: { createdEvaluationId: 7, storageWrites: [write(7, '2024-05-10')] },
      },
    });
    d.repoDelete.mockRejectedValue(new Error('db down'));

    await rollback(h.job);

    expect(d.storeDelete).toHaveBeenCalledTimes(1);
    expect(h.data.evaluationId).toBe(7);
    expect(h.data.__rollback).toEqual({ createdEvaluationId: 7 });
  });

  it('still removes the database record when every storage delete fails, keeping the writes in original order', async () => {
    const writes = [write(7, '2024-05-10'), write(7, '2024-05-11'), write(7, '2024-05-12')];
    const { d, h, rollback } = setup({
      data: { evaluationId: 7, __rollback: { createdEvaluationId: 7, storageWrites: writes } },
    });
    d.storeDelete.mockRejectedValue(new Error('s3 down'));

    await rollback(h.job);

    expect(d.repoDelete).toHaveBeenCalledWith(7);
    expect(h.data.evaluationId).toBeUndefined();
    expect(h.data.__rollback).toEqual({ storageWrites: writes });
  });

  it('keeps only the writes that failed, in original order', async () => {
    const writes = [write(7, '2024-05-10'), write(7, '2024-05-11'), write(7, '2024-05-12')];
    const { d, h, rollback } = setup({
      data: { __rollback: { storageWrites: writes } },
    });
    d.storeDelete.mockImplementation(async (arg: { evaluationDate: string }) => {
      if (arg.evaluationDate !== '2024-05-11') return;
      throw new Error('boom');
    });

    await rollback(h.job);

    expect(h.data.__rollback).toEqual({ storageWrites: [write(7, '2024-05-11')] });
  });

  it('retries only the leftovers on a second run and then clears the journal', async () => {
    const writes = [write(7, '2024-05-10'), write(7, '2024-05-11'), write(7, '2024-05-12')];
    const { d, h, rollback } = setup({
      data: { __rollback: { storageWrites: writes } },
    });
    d.storeDelete.mockImplementationOnce(async () => undefined);
    d.storeDelete.mockRejectedValueOnce(new Error('transient'));
    d.storeDelete.mockImplementationOnce(async () => undefined);

    await rollback(h.job);
    expect(h.data.__rollback?.storageWrites).toHaveLength(1);
    d.storeDelete.mockClear();

    await rollback(h.job);

    expect(d.storeDelete).toHaveBeenCalledTimes(1);
    expect(h.data.__rollback).toBeUndefined();
  });

  it('is a no-op when run again after a fully successful rollback', async () => {
    const { d, h, rollback } = setup({
      data: {
        evaluationId: 7,
        __rollback: { createdEvaluationId: 7, storageWrites: [write(7, '2024-05-10')] },
      },
    });
    await rollback(h.job);
    d.storeDelete.mockClear();
    d.repoDelete.mockClear();
    h.updateData.mockClear();

    await rollback(h.job);

    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.repoDelete).not.toHaveBeenCalled();
    expect(h.updateData).not.toHaveBeenCalled();
  });

  it('does not act on the metrics flag (that is handled by the private executor)', async () => {
    const { d, h, rollback } = setup({ data: { __rollback: { isMetricsPublished: true } } });

    await rollback(h.job);

    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.repoDelete).not.toHaveBeenCalled();
    expect(d.metricsRollbackAdd).not.toHaveBeenCalled();
  });

  it('never throws even when everything fails', async () => {
    const { d, h, l, rollback } = setup({
      data: {
        __rollback: { createdEvaluationId: 7, storageWrites: [write(7, '2024-05-10')] },
      },
    });
    d.storeDelete.mockRejectedValue(new Error('s3 down'));
    d.repoDelete.mockRejectedValue(new Error('db down'));
    h.updateData.mockRejectedValue(new Error('redis down'));

    await expect(rollback(h.job)).resolves.toBeUndefined();

    expect(l.error).toHaveBeenCalledTimes(3);
  });
});
