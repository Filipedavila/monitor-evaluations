import { Job } from 'bullmq';
import { EvaluationJobData } from '@evaluation/types';
import { PageStatus } from '@evaluation/domain/evaluation.constants';
import { createPageStatusUpdater } from './page-status';
import { WorkerTelemetry } from './worker-telemetry';
import { BaseWorkerDeps, WorkerConfig, WorkerLogger } from './worker.types';

/** Chamado apenas na última tentativa do job. */
export function createFailureHandler(
  deps: BaseWorkerDeps,
  config: WorkerConfig,
  logger: WorkerLogger,
  telemetry: WorkerTelemetry,
) {
  const setPageStatus = createPageStatusUpdater(deps.dataSource, config.pageTable);

  async function sendToDlq(job: Job<EvaluationJobData>, error: Error): Promise<void> {
    try {
      await deps.dlqQueue.add('failed-job', config.buildDlqPayload(job, error));
      telemetry.recordDeadLettered();
    } catch (dlqError) {
      const errorMessage = dlqError instanceof Error ? dlqError.message : String(dlqError);
      logger.error(`Failed to push job ${job.id} to DLQ: ${errorMessage}`);
    }
  }

  async function markPageFailed(job: Job<EvaluationJobData>, error: Error): Promise<void> {
    try {
      await setPageStatus(PageStatus.FAILED, job.data.pageId);

      deps.eventBus.emit('evaluation.failed', {
        jobData: job.data,
        error: error.message,
      });
    } catch (cleanupError) {
      const errorMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logger.error(
        `Falha ao marcar status FAILED para a página ${job.data.pageId}: ${errorMessage}`,
      );
    }
  }

  return async function handleFinalFailure(
    job: Job<EvaluationJobData>,
    error: Error,
  ): Promise<void> {
    telemetry.recordFinalFailure();
    await sendToDlq(job, error);
    await markPageFailed(job, error);
  };
}
