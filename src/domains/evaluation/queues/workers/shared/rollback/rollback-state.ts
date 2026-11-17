import type { EvaluationId } from '../worker.types';

/**
 * Storage file written by this job.
 * The path depends on both the evaluation ID and date.
 */
export interface StorageWrite {
  evaluationId: EvaluationId;
  /** Date in YYYY-MM-DD format, as passed to storage. */
  evaluationDate: string;
}

/**
 * Rollback state for the current job, containing all information needed to undo its actions.
 */
export interface RollbackState {
  /** Evaluation created by this job (absent if the ID came from the producer - re-evaluation). */
  createdEvaluationId?: EvaluationId;
  /** Files written to storage by this job. */
  storageWrites?: StorageWrite[];
  /** Whether metrics were published. */
  isMetricsPublished?: boolean;
}
