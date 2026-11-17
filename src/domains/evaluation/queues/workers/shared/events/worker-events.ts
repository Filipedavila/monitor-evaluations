import { Job, Worker } from 'bullmq';
import { FinalFailureHandler } from '../worker.types';
import { EvaluationJobData } from '@evaluation/types';
import { EvaluationEventBus } from '@events/evaluation-events';
import { createLogger } from '@logger/logger';

export interface WorkerEventsOptions<TResult> {
  describeResult?: (result: TResult) => string;
  recoverStalledJob?: FinalFailureHandler;
}

const STALLED_LIMIT_MESSAGE = 'stalled more than allowable limit';

export function attachEvaluationWorkerEvents<TResult>(
  worker: Worker<EvaluationJobData, TResult, string>,
  eventBus: EvaluationEventBus,
  loggerContext: string,
  options: WorkerEventsOptions<TResult> = {},
): void {
  const logger = createLogger(loggerContext);

  worker.on('active', (job: Job) => {
    logger.log(`🏃 Job ${job.id} started processing.`);
    eventBus.emit('evaluation.active', job.data);
  });

  worker.on('completed', (job: Job, result: TResult) => {
    const details = options.describeResult ? ` ${options.describeResult(result)}` : '';
    logger.log(`Job ${job.id} completed successfully!${details}`);
  });

  const { recoverStalledJob } = options;
  if (recoverStalledJob) {
    worker.on('failed', (job: Job | undefined, error: Error) => {
      if (!job || !error.message.includes(STALLED_LIMIT_MESSAGE)) return;

      logger.error(`Job ${job.id} failed due to stall; executing rollback from journal.`);
      recoverStalledJob(job, error).catch((recoveryError: unknown) => {
        const msg = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        logger.error(`Recovery for job ${job.id} failed: ${msg}`);
      });
    });
  }
}
