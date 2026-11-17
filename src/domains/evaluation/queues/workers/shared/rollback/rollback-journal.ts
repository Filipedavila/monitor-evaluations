import { Job } from 'bullmq';

import { RollbackState, StorageWrite } from './rollback-state';
import { EvaluationId } from '../worker.types';
import { EvaluationJobData } from '@evaluation/types';

// RollbackJournal keeps track of changes made by the job, allowing for rollback if needed.
export class RollbackJournal {
  constructor(private readonly job: Job<EvaluationJobData>) {}

  private get state(): RollbackState {
    return this.job.data.__rollback ?? {};
  }

  private async persist(
    patch: Partial<RollbackState>,
    extra: Partial<EvaluationJobData> = {},
  ): Promise<void> {
    await this.job.updateData({
      ...this.job.data,
      ...extra,
      __rollback: { ...this.state, ...patch },
    });
  }

  async recordCreatedEvaluation(evaluationId: EvaluationId): Promise<void> {
    await this.persist({ createdEvaluationId: evaluationId }, { evaluationId });
  }

  async recordStorageWrite(write: StorageWrite): Promise<void> {
    const writes = this.state.storageWrites ?? [];
    const alreadyRecorded = writes.some(
      (w) => w.evaluationId === write.evaluationId && w.evaluationDate === write.evaluationDate,
    );
    if (alreadyRecorded) return;

    await this.persist({ storageWrites: [...writes, write] });
  }

  async recordMetricsPublished(): Promise<void> {
    const metricsPublished = this.state.isMetricsPublished ?? false;
    if (metricsPublished) return;

    await this.persist({ isMetricsPublished: true });
  }
}
