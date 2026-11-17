jest.mock('@logger/logger', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => logger), __logger: logger };
});

jest.mock('@evaluation/mapper/mapper', () => ({
  toEvaluationDTO: jest.fn((evaluation: { id: number }) => ({ id: evaluation.id, mapped: true })),
}));

import { EventEmitter } from 'events';
import type { Job, Worker } from 'bullmq';
import type { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';
import type { EvaluationJobData } from '@evaluation/types';
import {
  attachEvaluationPublicWorkerEvents,
  createEvaluationPublicProcessor,
  createEvaluationPublicRecovery,
} from '@domains/evaluation/queues/workers/public/evaluation-public.worker';
import {
  attachEvaluationPrivateWorkerEvents,
  createEvaluationPrivateProcessor,
} from '@domains/evaluation/queues/workers/private/evaluation-private.worker';
import {
  buildJobData,
  buildParsedEvaluation,
  createDepsHarness,
  createJobHarness,
  firstCallOrder,
  flushPromises,
  primeHappyPath,
  STORAGE_DATE,
} from 'test/helpers/worker-test-utils';

interface LoggerHandle {
  log: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
}
const logger = jest.requireMock<{ __logger: LoggerHandle }>('@logger/logger').__logger;

describe('public worker flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('processes a job end to end', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    const h = createJobHarness<EvaluationDTO>({ attempts: 3 });
    const process = createEvaluationPublicProcessor(d.deps);

    const result = await process(h.job);

    expect(result).toEqual({ id: 7, mapped: true });
    expect(d.repoUpsert).toHaveBeenCalledTimes(1);
    expect(d.storeSave).toHaveBeenCalledTimes(1);
    expect(d.repoComplete).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('evaluation.completed', expect.anything());
    expect(d.dlqAdd).not.toHaveBeenCalled();
    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.repoDelete).not.toHaveBeenCalled();
  });

  it('rolls everything back, dead-letters and marks the page failed when the last attempt fails in storage', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    d.storeSave.mockRejectedValue(new Error('s3 down'));
    const h = createJobHarness<EvaluationDTO>({ attempts: 1 });
    const process = createEvaluationPublicProcessor(d.deps);

    await expect(process(h.job)).rejects.toThrow('s3 down');

    expect(d.storeDelete).toHaveBeenCalledWith({
      evaluationId: 7,
      websiteId: 5,
      pageId: 10,
      evaluationDate: STORAGE_DATE,
    });
    expect(d.repoDelete).toHaveBeenCalledWith(7);
    expect(d.dlqAdd).toHaveBeenCalledWith(
      'failed-job',
      expect.objectContaining({ originalJobId: 'job-1', failedReason: 's3 down' }),
    );
    expect(d.query).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith(
      'evaluation.failed',
      expect.objectContaining({ error: 's3 down' }),
    );
    expect(h.data.evaluationId).toBeUndefined();
    expect(h.data.__rollback).toBeUndefined();
    expect(firstCallOrder(d.repoDelete)).toBeLessThan(firstCallOrder(d.dlqAdd));
  });

  it('retries without rolling back and then succeeds reusing the evaluation created by the first attempt', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    d.repoComplete.mockRejectedValueOnce(new Error('transient db error'));
    const h = createJobHarness<EvaluationDTO>({ attempts: 3 });
    const process = createEvaluationPublicProcessor(d.deps);

    await expect(process(h.job)).rejects.toThrow('transient db error');
    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.repoDelete).not.toHaveBeenCalled();
    expect(d.dlqAdd).not.toHaveBeenCalled();

    h.setAttemptsMade(1);
    const result = await process(h.job);

    expect(result).toEqual({ id: 7, mapped: true });
    expect(d.engineEvaluate).toHaveBeenCalledTimes(2);
    expect(d.repoUpsert).toHaveBeenCalledTimes(1);
    expect(d.repoComplete).toHaveBeenCalledTimes(2);
    expect(d.repoComplete.mock.calls.map(([id]) => id)).toEqual([7, 7]);
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.dlqAdd).not.toHaveBeenCalled();
  });

  it('rolls back exactly once after all attempts are exhausted', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    d.storeSave.mockRejectedValue(new Error('s3 down'));
    const h = createJobHarness<EvaluationDTO>({ attempts: 3 });
    const process = createEvaluationPublicProcessor(d.deps);

    for (const attemptsMade of [0, 1, 2]) {
      h.setAttemptsMade(attemptsMade);
      await expect(process(h.job)).rejects.toThrow('s3 down');
    }

    expect(d.repoUpsert).toHaveBeenCalledTimes(1);
    expect(d.repoDelete).toHaveBeenCalledTimes(1);
    expect(d.dlqAdd).toHaveBeenCalledTimes(1);
  });

  it('removes the storage written on every attempt, even when the evaluation date changes between retries', async () => {
    const d = createDepsHarness();
    primeHappyPath(d, { evaluatedAt: '2024-05-10T10:00:00.000Z' });
    d.storeSave.mockRejectedValue(new Error('s3 down'));
    const h = createJobHarness<EvaluationDTO>({ attempts: 2 });
    const process = createEvaluationPublicProcessor(d.deps);

    await expect(process(h.job)).rejects.toThrow('s3 down');
    d.parseEvaluation.mockReturnValue(buildParsedEvaluation('2024-05-11T10:00:00.000Z'));
    h.setAttemptsMade(1);
    await expect(process(h.job)).rejects.toThrow('s3 down');

    expect(d.storeDelete.mock.calls.map(([arg]) => arg.evaluationDate)).toEqual([
      '2024-05-11',
      '2024-05-10',
    ]);
    expect(d.repoDelete).toHaveBeenCalledTimes(1);
  });

  it('fails without any side effect when the engine returns nothing, and cleans up on the last attempt', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    d.engineEvaluate.mockResolvedValue(undefined);
    const h = createJobHarness<EvaluationDTO>({ attempts: 1 });
    const process = createEvaluationPublicProcessor(d.deps);

    await expect(process(h.job)).rejects.toThrow('Evaluation Engine returned no result');

    expect(d.repoUpsert).not.toHaveBeenCalled();
    expect(d.repoDelete).not.toHaveBeenCalled();
    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.dlqAdd).toHaveBeenCalledTimes(1);
  });

  describe('stalled job recovery', () => {
    it('rolls back the journal of a job that stalled mid-run', async () => {
      const d = createDepsHarness();
      const worker = new EventEmitter();
      attachEvaluationPublicWorkerEvents(
        worker as unknown as Worker<EvaluationJobData, EvaluationDTO, string>,
        d.deps.eventBus,
        createEvaluationPublicRecovery(d.deps),
      );
      const stalled = createJobHarness({
        data: {
          evaluationId: 7,
          __rollback: {
            createdEvaluationId: 7,
            storageWrites: [{ evaluationId: 7, evaluationDate: STORAGE_DATE }],
          },
        },
      });

      worker.emit('failed', stalled.job, new Error('job stalled more than allowable limit'));
      await flushPromises();

      expect(d.storeDelete).toHaveBeenCalledTimes(1);
      expect(d.repoDelete).toHaveBeenCalledWith(7);
      expect(d.dlqAdd).toHaveBeenCalledTimes(1);
    });

    it('does not run recovery for ordinary failures', async () => {
      const d = createDepsHarness();
      const worker = new EventEmitter();
      attachEvaluationPublicWorkerEvents(
        worker as unknown as Worker<EvaluationJobData, EvaluationDTO, string>,
        d.deps.eventBus,
        createEvaluationPublicRecovery(d.deps),
      );
      const failed = createJobHarness({ data: { __rollback: { createdEvaluationId: 7 } } });

      worker.emit('failed', failed.job, new Error('ordinary failure'));
      await flushPromises();

      expect(d.repoDelete).not.toHaveBeenCalled();
      expect(d.dlqAdd).not.toHaveBeenCalled();
    });
  });

  describe('event wiring', () => {
    it('describes the completed evaluation in the log (public)', () => {
      const d = createDepsHarness();
      const worker = new EventEmitter();
      attachEvaluationPublicWorkerEvents(
        worker as unknown as Worker<EvaluationJobData, EvaluationDTO, string>,
        d.deps.eventBus,
      );
      const job = { id: 'job-1', data: buildJobData() } as unknown as Job<EvaluationJobData>;

      worker.emit('completed', job, { id: 42 });

      expect(logger.log).toHaveBeenCalledWith('Job job-1 completed successfully! Evaluation 42');
    });

    it('does not add result details for the private worker', () => {
      const d = createDepsHarness();
      const worker = new EventEmitter();
      attachEvaluationPrivateWorkerEvents(
        worker as unknown as Worker<EvaluationJobData, EvaluationDTO, string>,
        d.deps.eventBus,
      );
      const job = { id: 'job-1', data: buildJobData() } as unknown as Job<EvaluationJobData>;

      worker.emit('completed', job, { id: 42 });

      expect(logger.log).toHaveBeenCalledWith('Job job-1 completed successfully!');
    });
  });
});

describe('private worker flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('processes a job end to end and publishes the metrics', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    const h = createJobHarness<EvaluationDTO>({ attempts: 3 });
    const process = createEvaluationPrivateProcessor(d.deps);

    const result = await process(h.job);

    expect(result).toEqual({ id: 7, mapped: true });
    expect(d.repoComplete).toHaveBeenCalledWith(7, expect.anything(), 'page_contexts_ams', 10);
    expect(d.publishMetrics).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('evaluation.completed', expect.anything());
  });

  it('rolls back the record and storage when completing the evaluation fails on the last attempt', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    d.repoComplete.mockRejectedValue(new Error('constraint violation'));
    const h = createJobHarness<EvaluationDTO>({ attempts: 1 });
    const process = createEvaluationPrivateProcessor(d.deps);

    await expect(process(h.job)).rejects.toThrow('constraint violation');

    expect(d.storeDelete).toHaveBeenCalledTimes(1);
    expect(d.repoDelete).toHaveBeenCalledWith(7);
    expect(d.publishMetrics).not.toHaveBeenCalled();
    expect(d.metricsRollbackAdd).not.toHaveBeenCalled();
    expect(d.dlqAdd).toHaveBeenCalledWith(
      'failed-job',
      expect.objectContaining({
        originalJobId: 'job-1',
        error: expect.objectContaining({ message: 'constraint violation' }),
      }),
    );
    expect(d.query.mock.calls[0][0]).toContain('page_contexts_ams');
  });

  it('keeps upserting the same evaluation across retries', async () => {
    const d = createDepsHarness();
    primeHappyPath(d);
    d.publishMetrics.mockRejectedValueOnce(new Error('redis stream down'));
    const h = createJobHarness<EvaluationDTO>({ attempts: 3 });
    const process = createEvaluationPrivateProcessor(d.deps);

    await expect(process(h.job)).rejects.toThrow('redis stream down');
    h.setAttemptsMade(1);
    await expect(process(h.job)).resolves.toEqual({ id: 7, mapped: true });

    expect(d.repoUpsert).toHaveBeenCalledTimes(2);
    expect(d.repoUpsert.mock.calls[1][0].id).toBe(7);
    expect(d.repoDelete).not.toHaveBeenCalled();
  });

  // Known gap: publishMetrics is not journaled, so a failure after it never enqueues the
  // metrics rollback. When the pipeline records the flag and the executor consumes it,
  // change `it.failing` to `it`.
  it.failing(
    'rolls back the published Redis metrics when a later step fails on the last attempt',
    async () => {
      const d = createDepsHarness();
      primeHappyPath(d);
      d.emit.mockImplementation((event: string) => {
        if (event === 'evaluation.completed') throw new Error('listener failed');
      });
      const h = createJobHarness<EvaluationDTO>({ attempts: 1 });
      const process = createEvaluationPrivateProcessor(d.deps);

      await expect(process(h.job)).rejects.toThrow('listener failed');

      expect(d.publishMetrics).toHaveBeenCalledTimes(1);
      expect(d.metricsRollbackAdd).toHaveBeenCalledWith('rollback', { evaluationId: 7 });
    },
  );
});
