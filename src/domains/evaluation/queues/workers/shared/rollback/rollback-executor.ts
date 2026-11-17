import { Job } from 'bullmq';
import { RollbackState, StorageWrite } from '../rollback/rollback-state';
import { BaseWorkerDeps, WorkerLogger } from '../worker.types';
import { EvaluationJobData } from '@evaluation/types';

async function rollbackStorageWrites(
  writes: StorageWrite[],
  websiteId: number,
  pageId: number,
  deps: BaseWorkerDeps,
  logger: WorkerLogger,
): Promise<StorageWrite[]> {
  const failed: StorageWrite[] = [];

  // Process in reverse order (LIFO)
  for (const write of [...writes].reverse()) {
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
      failed.push(write);
    }
  }

  return failed.reverse();
}

async function rollbackDatabaseRecord(
  evaluationId: number,
  deps: BaseWorkerDeps,
  logger: WorkerLogger,
): Promise<boolean> {
  try {
    logger.warn(`Rollback: Removing evaluation ${evaluationId} from database...`);
    await deps.evaluationRepository.delete(evaluationId);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Database rollback failed (evaluation ${evaluationId}): ${msg}`);
    return false;
  }
}

function buildLeftoverState(
  failedWrites: StorageWrite[],
  createdEvaluationId: number | undefined,
  dbRollbackSucceeded: boolean,
): RollbackState | undefined {
  const leftover: RollbackState = {};

  if (failedWrites.length > 0) {
    leftover.storageWrites = failedWrites;
  }

  if (createdEvaluationId && !dbRollbackSucceeded) {
    leftover.createdEvaluationId = createdEvaluationId;
  }

  const hasLeftover = leftover.createdEvaluationId !== undefined || !!leftover.storageWrites;
  return hasLeftover ? leftover : undefined;
}

async function updateJobAfterRollback(
  job: Job<EvaluationJobData>,
  leftover: RollbackState | undefined,
  evaluationWasDeleted: boolean,
  logger: WorkerLogger,
): Promise<void> {
  try {
    await job.updateData({
      ...job.data,
      evaluationId: evaluationWasDeleted ? undefined : job.data.evaluationId,
      __rollback: leftover,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to update job ${job.id} journal: ${msg}`);
  }
}

export function createRollbackExecutor(deps: BaseWorkerDeps, logger: WorkerLogger) {
  return async function rollback(job: Job<EvaluationJobData>): Promise<void> {
    const state = job.data.__rollback;
    if (!state) return;

    const { websiteId, pageId } = job.data;

    const failedWrites = await rollbackStorageWrites(
      state.storageWrites ?? [],
      websiteId,
      pageId,
      deps,
      logger,
    );

    let dbRollbackSucceeded = true;
    if (state.createdEvaluationId) {
      dbRollbackSucceeded = await rollbackDatabaseRecord(state.createdEvaluationId, deps, logger);
    }

    const leftover = buildLeftoverState(
      failedWrites,
      state.createdEvaluationId,
      dbRollbackSucceeded,
    );
    const evaluationWasDeleted = state.createdEvaluationId !== undefined && dbRollbackSucceeded;

    await updateJobAfterRollback(job, leftover, evaluationWasDeleted, logger);
  };
}
