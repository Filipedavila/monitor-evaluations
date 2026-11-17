import { Job } from 'bullmq';
import { RollbackState, StorageWrite } from '../shared/rollback/rollback-state';
import { BaseWorkerDeps, WorkerLogger } from '../shared/worker.types';
import { Queue } from 'bullmq';
import { EvaluationPublisher } from '@evaluation/contracts/evaluation-publisher.contract';
import { EvaluationRepository } from '@evaluation/infrastructure/persistence/evaluation.repository';
import { EvaluationJobData } from '@evaluation/types';

export interface EvaluationPrivateWorkerDeps extends BaseWorkerDeps {
  metricsRollbackQueue: Queue;
  evaluationPersister: EvaluationPublisher;
  evaluationRepository: EvaluationRepository;
}

export function createRollbackPrivateExecutor(
  deps: EvaluationPrivateWorkerDeps,
  logger: WorkerLogger,
) {
  return async function rollback(job: Job<EvaluationJobData>): Promise<void> {
    const state = job.data.__rollback;
    if (!state) return;

    const { websiteId, pageId } = job.data;
    const leftover: RollbackState = {};

    if (state.failedMetricRedis) {
      try {
        logger.warn(
          `Rollback: Removing failed metrics from Redis for evaluation ${state.createdEvaluationId}...`,
        );
        const job = await deps.metricsRollbackQueue.add('rollback', {
          evaluationId: state.createdEvaluationId,
        });
        if (!job) throw new Error('Failed to add rollback job to metricsRollbackQueue');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Metrics rollback failed (evaluation ${state.createdEvaluationId}): ${msg}`);
      }
    }

    const failedWrites: StorageWrite[] = [];
    for (const write of [...(state.storageWrites ?? [])].reverse()) {
      try {
        logger.warn(`Rollback: Removing storage files for evaluation ${write.evaluationId}...`);
        await deps.evaluationStore.delete({
          evaluationId: write.evaluationId,
          websiteId,
          pageId,
          evaluationDate: write.evaluationDate,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Storage rollback failed (evaluation ${write.evaluationId}): ${msg}`);
        failedWrites.push(write);
      }
    }
    if (failedWrites.length > 0) leftover.storageWrites = failedWrites.reverse();

    if (state.createdEvaluationId) {
      try {
        logger.warn(`Rollback: Removing evaluation ${state.createdEvaluationId} from database...`);
        await deps.evaluationRepository.delete(state.createdEvaluationId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Database rollback failed (evaluation ${state.createdEvaluationId}): ${msg}`);
        leftover.createdEvaluationId = state.createdEvaluationId;
      }
    }

    const hasLeftover = leftover.createdEvaluationId !== undefined || !!leftover.storageWrites;
    const evaluationDeleted = state.createdEvaluationId && !leftover.createdEvaluationId;

    try {
      await job.updateData({
        ...job.data,
        evaluationId: evaluationDeleted ? undefined : job.data.evaluationId,
        __rollback: hasLeftover ? leftover : undefined,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to update job ${job.id} journal: ${msg}`);
    }
  };
}
