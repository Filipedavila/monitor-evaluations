import { Job } from 'bullmq';
import { createPageStatusUpdater } from './page-status';
import { RollbackJournal } from './rollback/rollback-journal';
import { BaseWorkerDeps, EvaluationId, WorkerConfig } from './worker.types';
import { EvaluationParserService } from '@evaluation/application/evaluation-parser.service';
import { EvaluationJobData } from '@evaluation/types';

type EvaluationReport = ReturnType<EvaluationParserService['parseEvaluation']>['evaluationReport'];

/**
 * Passos que public e private fazem de forma idêntica.
 * Os passos que diferem (criação do registo, persistência, progress) ficam em cada pipeline.
 */
export function createSharedSteps(deps: BaseWorkerDeps, config: WorkerConfig) {
  const setPageStatus = createPageStatusUpdater(deps.dataSource, config.pageTable);

  async function evaluateOrThrow(url: string) {
    const result = await deps.evaluationEngine.evaluate(url);
    if (!result) throw new Error('Evaluation Engine returned no result');
    return result;
  }
  // Saves evaluation Artifacts to storage and records the write in the rollback journal
  async function saveToStorage(
    job: Job<EvaluationJobData>,
    evaluationId: EvaluationId,
    evaluationDate: string | Date,
    report: EvaluationReport,
    journal: RollbackJournal,
  ): Promise<void> {
    const { websiteId, pageId } = job.data;
    const storageEvaluationDate = new Date(evaluationDate).toISOString().slice(0, 10);

    await journal.recordStorageWrite({ evaluationId, evaluationDate: storageEvaluationDate });

    await deps.evaluationStore.save({
      htmlContent: report.snapshot.html,
      nodes: report.scoring.assertionEvidence,
      conformance: report.scoring.conform,
      evalIdentifier: { evaluationId, websiteId, pageId, evaluationDate: storageEvaluationDate },
    });
  }

  return { evaluateOrThrow, saveToStorage, setPageStatus };
}

export type SharedSteps = ReturnType<typeof createSharedSteps>;
