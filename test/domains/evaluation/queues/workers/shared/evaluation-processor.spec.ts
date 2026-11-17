jest.mock('@logger/logger', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => logger), __logger: logger };
});

jest.mock('@domains/evaluation/queues/workers/shared/worker-telemetry', () => {
  const span = { setStatus: jest.fn(), recordException: jest.fn(), end: jest.fn() };
  const telemetry = {
    tracer: {
      startActiveSpan: jest.fn(
        (_name: string, _options: unknown, _ctx: unknown, fn: (s: typeof span) => unknown) =>
          fn(span),
      ),
    },
    recordJob: jest.fn(),
    recordFinalFailure: jest.fn(),
    recordDeadLettered: jest.fn(),
  };
  return { createWorkerTelemetry: jest.fn(() => telemetry), __telemetry: telemetry, __span: span };
});

import { propagation, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { UnrecoverableError } from 'bullmq';
import {
  createEvaluationProcessor,
  createEvaluationRecovery,
} from '@domains/evaluation/queues/workers/shared/evaluation-processor';
import { createWorkerTelemetry } from '@domains/evaluation/queues/workers/shared/worker-telemetry';
import { RollbackJournal } from '@domains/evaluation/queues/workers/shared/rollback/rollback-journal';
import type { EvaluationPipeline } from '@domains/evaluation/queues/workers/shared/worker.types';
import PUBLIC_CONFIG from '@domains/evaluation/queues/workers/public/evaluation.public.config';
import PRIVATE_CONFIG from '@domains/evaluation/queues/workers/private/evaluation.private.config';
import {
  createDepsHarness,
  createJobHarness,
  firstCallOrder,
  journalState,
  type JobOptions,
} from 'test/helpers/worker-test-utils';
import type { WorkerConfig } from '@domains/evaluation/queues/workers/shared/worker.types';

interface SpanHandle {
  setStatus: jest.Mock;
  recordException: jest.Mock;
  end: jest.Mock;
}
interface TelemetryHandle {
  tracer: { startActiveSpan: jest.Mock };
  recordJob: jest.Mock;
  recordFinalFailure: jest.Mock;
  recordDeadLettered: jest.Mock;
}
interface LoggerHandle {
  log: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
}

const telemetryModule = jest.requireMock<{ __telemetry: TelemetryHandle; __span: SpanHandle }>(
  '@domains/evaluation/queues/workers/shared/worker-telemetry',
);
const telemetry = telemetryModule.__telemetry;
const span = telemetryModule.__span;
const logger = jest.requireMock<{ __logger: LoggerHandle }>('@logger/logger').__logger;

const journaled = {
  evaluationId: 55,
  __rollback: {
    createdEvaluationId: 55,
    storageWrites: [
      { evaluationId: 55, evaluationDate: '2024-05-10' },
      { evaluationId: 55, evaluationDate: '2024-05-11' },
    ],
  },
};

function setup(options: { config?: WorkerConfig; job?: JobOptions } = {}) {
  const d = createDepsHarness();
  const h = createJobHarness<string>(options.job);
  const pipeline = jest
    .fn<Promise<string>, Parameters<EvaluationPipeline<string>>>()
    .mockResolvedValue('result');
  const run = createEvaluationProcessor(d.deps, options.config ?? PUBLIC_CONFIG, pipeline);
  return { d, h, pipeline, run };
}

describe('createEvaluationProcessor', () => {
  let extractSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    extractSpy?.mockRestore();
    extractSpy = undefined;
  });

  describe('success', () => {
    it('returns the pipeline result and marks the span as OK', async () => {
      const { h, run } = setup({ job: { attempts: 3 } });

      await expect(run(h.job)).resolves.toBe('result');

      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(span.recordException).not.toHaveBeenCalled();
      expect(span.end).toHaveBeenCalledTimes(1);
      expect(telemetry.recordJob).toHaveBeenCalledWith('success', expect.any(Number));
    });

    it('creates telemetry for the worker name', () => {
      setup({ config: PRIVATE_CONFIG });

      expect(createWorkerTelemetry).toHaveBeenCalledWith('private');
    });

    it('hands the pipeline the job, config, a journal bound to the job and the shared steps', async () => {
      const { h, pipeline, run } = setup();

      await run(h.job);

      const [job, ctx] = pipeline.mock.calls[0];
      expect(job).toBe(h.job);
      expect(ctx.config).toBe(PUBLIC_CONFIG);
      expect(ctx.journal).toBeInstanceOf(RollbackJournal);
      expect(typeof ctx.steps.evaluateOrThrow).toBe('function');
      expect(typeof ctx.steps.saveToStorage).toBe('function');
      expect(typeof ctx.steps.setPageStatus).toBe('function');
    });

    it('does not roll back, dead-letter or mark the page on success', async () => {
      const { d, h, run } = setup({ job: { data: journaled } });

      await run(h.job);

      expect(d.storeDelete).not.toHaveBeenCalled();
      expect(d.repoDelete).not.toHaveBeenCalled();
      expect(d.dlqAdd).not.toHaveBeenCalled();
      expect(d.query).not.toHaveBeenCalled();
    });
  });

  describe('tracing', () => {
    it('names the span after the worker and exposes job attributes (public)', async () => {
      const { h, run } = setup();

      await run(h.job);

      expect(telemetry.tracer.startActiveSpan).toHaveBeenCalledWith(
        'evaluation-public-worker-process',
        {
          attributes: {
            'bullmq.job.id': 'job-1',
            'evaluation.page_id': 10,
            'evaluation.website_id': 5,
          },
        },
        expect.anything(),
        expect.any(Function),
      );
    });

    it('exposes the institution for the private worker', async () => {
      const { h, run } = setup({ config: PRIVATE_CONFIG });

      await run(h.job);

      expect(telemetry.tracer.startActiveSpan).toHaveBeenCalledWith(
        'evaluation-private-worker-process',
        {
          attributes: {
            'bullmq.job.id': 'job-1',
            'evaluation.page_id': 10,
            'evaluation.institution_id': 3,
          },
        },
        expect.anything(),
        expect.any(Function),
      );
    });

    it('falls back to "unknown" when the job has no id', async () => {
      const { h, run } = setup({ job: { id: null } });

      await run(h.job);

      expect(telemetry.tracer.startActiveSpan).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          attributes: expect.objectContaining({ 'bullmq.job.id': 'unknown' }),
        }),
        expect.anything(),
        expect.any(Function),
      );
    });

    it('extracts the parent context from the job when a propagation carrier exists', async () => {
      const carrier = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
      extractSpy = jest.spyOn(propagation, 'extract').mockReturnValue(ROOT_CONTEXT);
      const { h, run } = setup({ job: { data: { __otelContext: carrier } } });

      await run(h.job);

      expect(extractSpy).toHaveBeenCalledWith(expect.anything(), carrier);
      expect(telemetry.tracer.startActiveSpan.mock.calls[0][2]).toBe(ROOT_CONTEXT);
    });

    it('does not extract a context when the job carries none', async () => {
      extractSpy = jest.spyOn(propagation, 'extract');
      const { h, run } = setup();

      await run(h.job);

      expect(extractSpy).not.toHaveBeenCalled();
    });
  });

  describe('failure handling', () => {
    it('rethrows the same error, records it on the span and logs it', async () => {
      const { h, pipeline, run } = setup({ job: { attempts: 3 } });
      const error = new Error('boom');
      pipeline.mockRejectedValue(error);

      await expect(run(h.job)).rejects.toBe(error);

      expect(span.recordException).toHaveBeenCalledWith(error);
      expect(span.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'boom',
      });
      expect(span.setStatus).not.toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('job-1'), error.stack);
      expect(telemetry.recordJob).toHaveBeenCalledWith('failure', expect.any(Number));
      expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('wraps non-Error rejections into an Error', async () => {
      const { h, pipeline, run } = setup();
      pipeline.mockRejectedValue('plain string');

      const thrown = await run(h.job).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('plain string');
    });

    it.each<[number, number | undefined, boolean]>([
      [0, 3, false],
      [1, 3, false],
      [2, 3, true],
      [3, 3, true],
      [0, 1, true],
      [0, undefined, true],
    ])(
      'with attemptsMade=%i and attempts=%s the failure is final: %s',
      async (attemptsMade, attempts, isFinal) => {
        const { d, h, pipeline, run } = setup({ job: { attemptsMade, attempts } });
        pipeline.mockRejectedValue(new Error('boom'));

        await expect(run(h.job)).rejects.toThrow('boom');

        expect(d.dlqAdd).toHaveBeenCalledTimes(isFinal ? 1 : 0);
        expect(telemetry.recordFinalFailure).toHaveBeenCalledTimes(isFinal ? 1 : 0);
      },
    );

    it('treats an UnrecoverableError as final even on the first attempt', async () => {
      const { d, h, pipeline, run } = setup({ job: { attempts: 5, attemptsMade: 0 } });
      pipeline.mockRejectedValue(new UnrecoverableError('fatal'));

      await expect(run(h.job)).rejects.toThrow('fatal');

      expect(d.dlqAdd).toHaveBeenCalledTimes(1);
    });

    it('does not roll back on intermediate attempts (steps are idempotent) and keeps the journal', async () => {
      const { d, h, pipeline, run } = setup({
        job: { attempts: 3, attemptsMade: 0, data: journaled },
      });
      pipeline.mockRejectedValue(new Error('boom'));

      await expect(run(h.job)).rejects.toThrow('boom');

      expect(d.storeDelete).not.toHaveBeenCalled();
      expect(d.repoDelete).not.toHaveBeenCalled();
      expect(d.dlqAdd).not.toHaveBeenCalled();
      expect(d.query).not.toHaveBeenCalled();
      expect(h.data.__rollback).toEqual(journaled.__rollback);
    });
  });

  describe('final attempt', () => {
    it('rolls back the journal, dead-letters the job and marks the page failed, in that order', async () => {
      const { d, h, pipeline, run } = setup({
        job: { attempts: 3, attemptsMade: 2, data: journaled },
      });
      pipeline.mockRejectedValue(new Error('boom'));

      await expect(run(h.job)).rejects.toThrow('boom');

      expect(d.storeDelete).toHaveBeenCalledTimes(2);
      expect(d.repoDelete).toHaveBeenCalledWith(55);
      expect(d.dlqAdd).toHaveBeenCalledWith(
        'failed-job',
        expect.objectContaining({ originalJobId: 'job-1', failedReason: 'boom' }),
      );
      expect(d.query).toHaveBeenCalledTimes(1);
      expect(d.emit).toHaveBeenCalledWith(
        'evaluation.failed',
        expect.objectContaining({ error: 'boom' }),
      );

      expect(firstCallOrder(d.storeDelete)).toBeLessThan(firstCallOrder(d.repoDelete));
      expect(firstCallOrder(d.repoDelete)).toBeLessThan(firstCallOrder(d.dlqAdd));
      expect(firstCallOrder(d.dlqAdd)).toBeLessThan(firstCallOrder(d.query));
    });

    it('rolls back what the pipeline journaled through the journal it received', async () => {
      const { d, h, pipeline, run } = setup({ job: { attempts: 1 } });
      pipeline.mockImplementation(async (_job, ctx) => {
        await ctx.journal.recordCreatedEvaluation(55);
        await ctx.journal.recordStorageWrite({ evaluationId: 55, evaluationDate: '2024-05-10' });
        throw new Error('after writes');
      });

      await expect(run(h.job)).rejects.toThrow('after writes');

      expect(d.storeDelete).toHaveBeenCalledWith({
        evaluationId: 55,
        websiteId: 5,
        pageId: 10,
        evaluationDate: '2024-05-10',
      });
      expect(d.repoDelete).toHaveBeenCalledWith(55);
    });

    it('keeps the original error when the rollback itself fails and still dead-letters', async () => {
      const { d, h, pipeline, run } = setup({
        job: { attempts: 1, data: journaled },
      });
      const original = new Error('original');
      pipeline.mockRejectedValue(original);
      d.storeDelete.mockRejectedValue(new Error('s3 down'));
      d.repoDelete.mockRejectedValue(new Error('db down'));

      await expect(run(h.job)).rejects.toBe(original);

      expect(d.dlqAdd).toHaveBeenCalledTimes(1);
    });

    it('keeps the original error when the DLQ push fails', async () => {
      const { d, h, pipeline, run } = setup({ job: { attempts: 1 } });
      const original = new Error('original');
      pipeline.mockRejectedValue(original);
      d.dlqAdd.mockRejectedValue(new Error('dlq down'));

      await expect(run(h.job)).rejects.toBe(original);
    });

    it('uses the standard rollback for the public worker (ignores the metrics flag)', async () => {
      const { d, h, pipeline, run } = setup({
        config: PUBLIC_CONFIG,
        job: {
          attempts: 1,
          data: {
            __rollback: journalState({ createdEvaluationId: 55, failedMetricRedis: true }),
          },
        },
      });
      pipeline.mockRejectedValue(new Error('boom'));

      await expect(run(h.job)).rejects.toThrow('boom');

      expect(d.metricsRollbackAdd).not.toHaveBeenCalled();
      expect(d.repoDelete).toHaveBeenCalledWith(55);
    });

    it('uses the private rollback for the private worker (enqueues the metrics rollback)', async () => {
      const { d, h, pipeline, run } = setup({
        config: PRIVATE_CONFIG,
        job: {
          attempts: 1,
          data: {
            __rollback: journalState({ createdEvaluationId: 55, failedMetricRedis: true }),
          },
        },
      });
      pipeline.mockRejectedValue(new Error('boom'));

      await expect(run(h.job)).rejects.toThrow('boom');

      expect(d.metricsRollbackAdd).toHaveBeenCalledWith('rollback', { evaluationId: 55 });
      expect(d.repoDelete).toHaveBeenCalledWith(55);
    });

    it('marks the page in the table configured for the worker', async () => {
      const { d, h, pipeline, run } = setup({
        config: PRIVATE_CONFIG,
        job: { attempts: 1 },
      });
      pipeline.mockRejectedValue(new Error('boom'));

      await expect(run(h.job)).rejects.toThrow('boom');

      expect(d.query.mock.calls[0][0]).toContain('page_contexts_ams');
    });
  });

  describe('retries', () => {
    it('lets the next attempt see the evaluation id journaled by the previous one', async () => {
      const { h, pipeline, run } = setup({ job: { attempts: 3, attemptsMade: 0 } });
      const seenEvaluationIds: Array<number | undefined> = [];
      pipeline.mockImplementation(async (job, ctx) => {
        seenEvaluationIds.push(job.data.evaluationId);
        if (job.data.evaluationId === undefined) {
          await ctx.journal.recordCreatedEvaluation(55);
          throw new Error('first attempt fails');
        }
        return 'recovered';
      });

      await expect(run(h.job)).rejects.toThrow('first attempt fails');
      h.setAttemptsMade(1);
      await expect(run(h.job)).resolves.toBe('recovered');

      expect(seenEvaluationIds).toEqual([undefined, 55]);
    });
  });
});

describe('createEvaluationRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rolls back and dead-letters a stalled job without going through the processor', async () => {
    const d = createDepsHarness();
    const h = createJobHarness({ data: journaled });
    const recover = createEvaluationRecovery(d.deps, PUBLIC_CONFIG);

    await recover(h.job, new Error('job stalled more than allowable limit'));

    expect(createWorkerTelemetry).toHaveBeenCalledWith('public');
    expect(d.storeDelete).toHaveBeenCalledTimes(2);
    expect(d.repoDelete).toHaveBeenCalledWith(55);
    expect(d.dlqAdd).toHaveBeenCalledWith(
      'failed-job',
      expect.objectContaining({ failedReason: 'job stalled more than allowable limit' }),
    );
    expect(d.query).toHaveBeenCalledTimes(1);
    expect(telemetry.recordFinalFailure).toHaveBeenCalledTimes(1);
  });

  it('uses the private rollback for the private worker', async () => {
    const d = createDepsHarness();
    const h = createJobHarness({
      data: { __rollback: journalState({ createdEvaluationId: 55, failedMetricRedis: true }) },
    });
    const recover = createEvaluationRecovery(d.deps, PRIVATE_CONFIG);

    await recover(h.job, new Error('stalled'));

    expect(createWorkerTelemetry).toHaveBeenCalledWith('private');
    expect(d.metricsRollbackAdd).toHaveBeenCalledWith('rollback', { evaluationId: 55 });
  });

  it('still dead-letters a job that has no journal', async () => {
    const d = createDepsHarness();
    const h = createJobHarness();
    const recover = createEvaluationRecovery(d.deps, PUBLIC_CONFIG);

    await recover(h.job, new Error('stalled'));

    expect(d.storeDelete).not.toHaveBeenCalled();
    expect(d.repoDelete).not.toHaveBeenCalled();
    expect(d.dlqAdd).toHaveBeenCalledTimes(1);
  });
});
