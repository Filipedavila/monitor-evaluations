jest.mock('@logger/logger', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => logger), __logger: logger };
});

import { EventEmitter } from 'events';
import type { Job, Worker } from 'bullmq';
import { createLogger } from '@logger/logger';
import { attachEvaluationWorkerEvents } from '@evaluation/queues/workers/shared/events/worker-events';
import type { EvaluationEventBus } from '@events/evaluation-events';
import type { EvaluationJobData } from '@evaluation/types';
import { buildJobData, flushPromises } from 'test/helpers/worker-test-utils';

interface LoggerHandle {
  log: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
}

const logger = jest.requireMock<{ __logger: LoggerHandle }>('@logger/logger').__logger;
const STALL_MESSAGE = 'job stalled more than allowable limit';

function setup(options: Parameters<typeof attachEvaluationWorkerEvents<string>>[3] = {}) {
  const worker = new EventEmitter();
  const emit = jest.fn();
  const eventBus = { emit } as unknown as EvaluationEventBus;
  const job = { id: 'job-9', data: buildJobData() } as unknown as Job<EvaluationJobData>;

  attachEvaluationWorkerEvents(
    worker as unknown as Worker<EvaluationJobData, string, string>,
    eventBus,
    'TestWorker',
    options,
  );

  return { worker, emit, job };
}

describe('attachEvaluationWorkerEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the logger with the given context', () => {
    setup();

    expect(createLogger).toHaveBeenCalledWith('TestWorker');
  });

  describe('active', () => {
    it('logs and emits evaluation.active with the job data', () => {
      const { worker, emit, job } = setup();

      worker.emit('active', job);

      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Job job-9 started'));
      expect(emit).toHaveBeenCalledWith('evaluation.active', job.data);
    });
  });

  describe('completed', () => {
    it('logs success without details when no describeResult is provided', () => {
      const { worker, job } = setup();

      worker.emit('completed', job, 'ignored');

      expect(logger.log).toHaveBeenCalledWith('Job job-9 completed successfully!');
    });

    it('appends the description of the result', () => {
      const describeResult = jest.fn((result: string) => `result=${result}`);
      const { worker, job } = setup({ describeResult });

      worker.emit('completed', job, 'ok');

      expect(describeResult).toHaveBeenCalledWith('ok');
      expect(logger.log).toHaveBeenCalledWith('Job job-9 completed successfully! result=ok');
    });
  });

  describe('stalled job recovery', () => {
    it('does not register a failed listener without a recovery handler', () => {
      const { worker } = setup();

      expect(worker.listenerCount('failed')).toBe(0);
    });

    it('runs the recovery handler when the job failed because it stalled', async () => {
      const recoverStalledJob = jest.fn().mockResolvedValue(undefined);
      const { worker, job } = setup({ recoverStalledJob });
      const error = new Error(STALL_MESSAGE);

      worker.emit('failed', job, error);
      await flushPromises();

      expect(recoverStalledJob).toHaveBeenCalledWith(job, error);
      expect(logger.error).toHaveBeenCalledWith(
        'Job job-9 failed due to stall; executing rollback from journal.',
      );
    });

    it('ignores failures that are not stalls', async () => {
      const recoverStalledJob = jest.fn().mockResolvedValue(undefined);
      const { worker, job } = setup({ recoverStalledJob });

      worker.emit('failed', job, new Error('some other failure'));
      await flushPromises();

      expect(recoverStalledJob).not.toHaveBeenCalled();
    });

    it('ignores failed events without a job', async () => {
      const recoverStalledJob = jest.fn().mockResolvedValue(undefined);
      const { worker } = setup({ recoverStalledJob });

      worker.emit('failed', undefined, new Error(STALL_MESSAGE));
      await flushPromises();

      expect(recoverStalledJob).not.toHaveBeenCalled();
    });

    it('logs a failing recovery instead of leaking an unhandled rejection', async () => {
      const recoverStalledJob = jest.fn().mockRejectedValue(new Error('recovery blew up'));
      const { worker, job } = setup({ recoverStalledJob });

      worker.emit('failed', job, new Error(STALL_MESSAGE));
      await flushPromises();

      expect(logger.error).toHaveBeenCalledWith('Recovery for job job-9 failed: recovery blew up');
    });

    it('stringifies non-Error recovery failures', async () => {
      const recoverStalledJob = jest.fn().mockRejectedValue('plain failure');
      const { worker, job } = setup({ recoverStalledJob });

      worker.emit('failed', job, new Error(STALL_MESSAGE));
      await flushPromises();

      expect(logger.error).toHaveBeenCalledWith('Recovery for job job-9 failed: plain failure');
    });
  });
});
