import { createRollbackPrivateExecutor } from '@evaluation/queues/workers/private/rollback-executor.private';
import type { StorageWrite } from '@evaluation/queues/workers/shared/rollback/rollback-state';
import {
  createDepsHarness,
  createJobHarness,
  createLoggerHarness,
  firstCallOrder,
  journalState,
} from 'test/helpers/worker-test-utils';

const write = (evaluationId: number, evaluationDate: string): StorageWrite => ({
  evaluationId,
  evaluationDate,
});

function setup(data: Parameters<typeof createJobHarness>[0] = {}) {
  const d = createDepsHarness();
  const h = createJobHarness(data);
  const l = createLoggerHarness();
  const rollback = createRollbackPrivateExecutor(d.deps, l.logger);
  return { d, h, l, rollback };
}

describe('createRollbackPrivateExecutor', () => {
  describe('without journal', () => {
    it('does nothing when there is no journal', async () => {
      const { d, h, rollback } = setup();

      await rollback(h.job);

      expect(d.storeDelete).not.toHaveBeenCalled();
      expect(d.repoDelete).not.toHaveBeenCalled();
      expect(d.metricsRollbackAdd).not.toHaveBeenCalled();
      expect(h.updateData).not.toHaveBeenCalled();
    });
  });

  describe('Redis metrics rollback', () => {
    const stateWithMetrics = journalState({ createdEvaluationId: 55, failedMetricRedis: true });

    it('enqueues a rollback job for the evaluation metrics', async () => {
      const { d, h, l, rollback } = setup({
        data: { evaluationId: 55, __rollback: stateWithMetrics },
      });

      await rollback(h.job);

      expect(d.metricsRollbackAdd).toHaveBeenCalledWith('rollback', { evaluationId: 55 });
      expect(l.warn).toHaveBeenCalledWith(
        'Rollback: Removing failed metrics from Redis for evaluation 55...',
      );
    });

    it('does not enqueue anything when the flag is absent', async () => {
      const { d, h, rollback } = setup({
        data: { evaluationId: 55, __rollback: journalState({ createdEvaluationId: 55 }) },
      });

      await rollback(h.job);

      expect(d.metricsRollbackAdd).not.toHaveBeenCalled();
    });

    it('enqueues the metrics rollback before touching storage and database', async () => {
      const { d, h, rollback } = setup({
        data: {
          evaluationId: 55,
          __rollback: journalState({
            createdEvaluationId: 55,
            failedMetricRedis: true,
            storageWrites: [write(55, '2024-05-10')],
          }),
        },
      });

      await rollback(h.job);

      expect(firstCallOrder(d.metricsRollbackAdd)).toBeLessThan(firstCallOrder(d.storeDelete));
      expect(firstCallOrder(d.metricsRollbackAdd)).toBeLessThan(firstCallOrder(d.repoDelete));
    });

    it('logs and continues with storage and database when the queue rejects', async () => {
      const { d, h, l, rollback } = setup({
        data: {
          evaluationId: 55,
          __rollback: journalState({
            createdEvaluationId: 55,
            failedMetricRedis: true,
            storageWrites: [write(55, '2024-05-10')],
          }),
        },
      });
      d.metricsRollbackAdd.mockRejectedValue(new Error('redis unavailable'));

      await rollback(h.job);

      expect(l.error).toHaveBeenCalledWith(
        'Metrics rollback failed (evaluation 55): redis unavailable',
      );
      expect(d.storeDelete).toHaveBeenCalledTimes(1);
      expect(d.repoDelete).toHaveBeenCalledWith(55);
    });

    it('treats an empty enqueue result as a failure and keeps going', async () => {
      const { d, h, l, rollback } = setup({
        data: { evaluationId: 55, __rollback: stateWithMetrics },
      });
      d.metricsRollbackAdd.mockResolvedValue(undefined);

      await rollback(h.job);

      expect(l.error).toHaveBeenCalledWith(
        'Metrics rollback failed (evaluation 55): Failed to add rollback job to metricsRollbackQueue',
      );
      expect(d.repoDelete).toHaveBeenCalledWith(55);
    });
  });

  describe('storage and database', () => {
    it('removes storage writes in reverse order, then the database record', async () => {
      const { d, h, rollback } = setup({
        data: {
          evaluationId: 7,
          __rollback: {
            createdEvaluationId: 7,
            storageWrites: [write(7, '2024-05-10'), write(7, '2024-05-11')],
          },
        },
      });

      await rollback(h.job);

      expect(d.storeDelete.mock.calls.map(([arg]) => arg.evaluationDate)).toEqual([
        '2024-05-11',
        '2024-05-10',
      ]);
      expect(d.storeDelete).toHaveBeenCalledWith(
        expect.objectContaining({ websiteId: 5, pageId: 10, evaluationId: 7 }),
      );
      expect(d.repoDelete).toHaveBeenCalledWith(7);
      expect(h.data.evaluationId).toBeUndefined();
      expect(h.data.__rollback).toBeUndefined();
    });

    it('keeps failed writes in original order', async () => {
      const writes = [write(7, '2024-05-10'), write(7, '2024-05-11'), write(7, '2024-05-12')];
      const { d, h, rollback } = setup({ data: { __rollback: { storageWrites: writes } } });
      d.storeDelete.mockImplementation(async (arg: { evaluationDate: string }) => {
        if (arg.evaluationDate === '2024-05-10' || arg.evaluationDate === '2024-05-12') {
          throw new Error('s3 down');
        }
      });

      await rollback(h.job);

      expect(h.data.__rollback).toEqual({
        storageWrites: [write(7, '2024-05-10'), write(7, '2024-05-12')],
      });
    });

    it('keeps the created id and the evaluationId when the database delete fails', async () => {
      const { d, h, l, rollback } = setup({
        data: { evaluationId: 7, __rollback: { createdEvaluationId: 7 } },
      });
      d.repoDelete.mockRejectedValue(new Error('db down'));

      await rollback(h.job);

      expect(l.error).toHaveBeenCalledWith('Database rollback failed (evaluation 7): db down');
      expect(h.data.evaluationId).toBe(7);
      expect(h.data.__rollback).toEqual({ createdEvaluationId: 7 });
    });

    it('does not delete from the database nor clear the evaluationId when the id came from the producer', async () => {
      const { d, h, rollback } = setup({
        data: { evaluationId: 77, __rollback: { storageWrites: [write(77, '2024-05-10')] } },
      });

      await rollback(h.job);

      expect(d.repoDelete).not.toHaveBeenCalled();
      expect(h.data.evaluationId).toBe(77);
    });

    it('stringifies non-Error failures', async () => {
      const { d, h, l, rollback } = setup({
        data: { __rollback: { storageWrites: [write(7, '2024-05-10')] } },
      });
      d.storeDelete.mockRejectedValue('plain failure');

      await rollback(h.job);

      expect(l.error).toHaveBeenCalledWith('Storage rollback failed (evaluation 7): plain failure');
    });

    it('logs and does not throw when the journal cannot be updated', async () => {
      const { h, l, rollback } = setup({
        id: 'job-9',
        data: { __rollback: { createdEvaluationId: 7 } },
      });
      h.updateData.mockRejectedValue(new Error('redis down'));

      await expect(rollback(h.job)).resolves.toBeUndefined();

      expect(l.error).toHaveBeenCalledWith('Failed to update job job-9 journal: redis down');
    });
  });
});
