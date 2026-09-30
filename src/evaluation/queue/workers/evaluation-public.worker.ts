import { Job, Queue, Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { Evaluation, PublishStatus } from '../../entities/evaluation.entity';
import { EvaluationEngine } from '../../contracts/evaluation-engine.contract';
import { EvaluationStorage } from '../../contracts/evaluation-storage.contract';
import { EvaluationParserService } from '../../evaluation-parser.service';
import { EvaluationJobData } from '../../types';
import { EvaluationRepository } from '../../evaluation.repository';
import { PageStatus } from '../../evaluation.constants';
import { EvaluationEventBus } from '../../../events/evaluation-events';
import { createLogger } from '../../../logger/logger';

const CONTEXT_ID = 2;

type CompensationAction = () => Promise<void>;

export interface EvaluationPublicWorkerDeps {
  dlqQueue: Queue;
  evaluationEngine: EvaluationEngine;
  evaluationStore: EvaluationStorage;
  evaluationParser: EvaluationParserService;
  evaluationRepository: EvaluationRepository;
  eventBus: EvaluationEventBus;
  dataSource: DataSource;
}

export function createEvaluationPublicProcessor(deps: EvaluationPublicWorkerDeps) {
  const logger = createLogger('EvaluationPublicWorker');

  async function executeCompensations(compensations: CompensationAction[]): Promise<void> {
    while (compensations.length > 0) {
      const rollback = compensations.pop();
      if (rollback) {
        try {
          await rollback();
        } catch (compensationError) {
          const msg =
            compensationError instanceof Error
              ? compensationError.message
              : String(compensationError);
          logger.error(`Falha ao executar ação de compensação: ${msg}`);
        }
      }
    }
  }

  async function handleFinalFailure(job: Job<EvaluationJobData>, error: Error): Promise<void> {
    try {
      await deps.dlqQueue.add('failed-job', {
        originalJobId: job.id,
        data: job.data,
        failedReason: error.message,
        stacktrace: error.stack,
        failedAt: new Date().toISOString(),
      });
    } catch (dlqError) {
      const errorMessage = dlqError instanceof Error ? dlqError.message : String(dlqError);
      logger.error(`Failed to push job ${job.id} to DLQ: ${errorMessage}`);
    }

    try {
      await deps.dataSource.query(
        `
        UPDATE page_contexts_monitor
        SET page_status = $1
        WHERE page_id = $2;
        `,
        [PageStatus.FAILED, job.data.pageId],
      );

      deps.eventBus.emit('evaluation.failed', {
        jobData: job.data,
        error: error.message,
      });
    } catch (cleanupError) {
      const cleanupErrorMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logger.error(
        `Failed to execute cleanup logic for job ${job.id}: ${cleanupErrorMessage}`,
      );
    }
  }

  return async function process(job: Job<EvaluationJobData, void, string>): Promise<void> {
    const { websiteId, evaluationId, pageId, url } = job.data;
    let evaluationIdJob = evaluationId;

    const compensations: CompensationAction[] = [];

    try {
      const evaluationResult = await deps.evaluationEngine.evaluate(url);
      if (!evaluationResult) throw new Error('Evaluation Engine returned no result');

      await job.updateProgress(50);
      job.log('Received Evaluation from Engine');

      const { evaluationReport, evaluationData } =
        deps.evaluationParser.parseEvaluation(evaluationResult);
      const evaluationDate = evaluationReport.metadata.evaluatedAt;

      if (!evaluationIdJob) {
        const evaluation = new Evaluation();
        evaluation.evaluationDate = new Date(evaluationDate);
        evaluation.pageId = pageId;

        const created = await deps.evaluationRepository.createEvaluation(evaluation, CONTEXT_ID);
        evaluationIdJob = created.id;

        compensations.push(async () => {
          logger.warn(`Compensação: A remover evaluation ${evaluationIdJob} da BD...`);
          await deps.evaluationRepository.delete(evaluationIdJob!);
        });

        await job.updateData({
          ...job.data,
          evaluationId: evaluationIdJob,
        });
      }

      const storageEvaluationDate = new Date(evaluationDate).toISOString().slice(0, 10);

      await deps.evaluationStore.save({
        htmlContent: evaluationReport.snapshot.html,
        nodes: evaluationReport.scoring.assertionEvidence,
        evalIdentifier: {
          evaluationId: evaluationIdJob,
          websiteId,
          pageId,
          evaluationDate: storageEvaluationDate,
        },
      });

      // Regista a compensação para o Storage
      compensations.push(async () => {
        logger.warn(
          `Compensação: A remover ficheiros do storage para evaluation ${evaluationIdJob}...`,
        );
        await deps.evaluationStore.delete({
          evaluationId: evaluationIdJob!,
          websiteId,
          pageId,
          evaluationDate: storageEvaluationDate,
        });
      });

      job.log('Saved compressed files in Storage');
      await job.updateProgress(70);

      await deps.evaluationRepository.updateEntityFromRawData(evaluationIdJob, evaluationData);
      await deps.evaluationRepository.updateStatus(evaluationIdJob, PublishStatus.STAGED);

      await deps.dataSource.query(
        `
        UPDATE page_contexts_monitor
        SET page_status = $1
        WHERE page_id = $2;
        `,
        [PageStatus.EVALUATED, pageId],
      );

      await job.updateProgress(100);
      job.log('Evaluation Resolution Ended');

      deps.eventBus.emit('evaluation.completed', {
        ...job.data,
        evaluationId: evaluationIdJob,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Erro no job ${job.id} (Página ${pageId}): ${err.message}`, err.stack);

      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      await executeCompensations(compensations);

      if (isFinalAttempt) {
        await handleFinalFailure(job, err);
      }

      throw err;
    }
  };
}

export function attachEvaluationPublicWorkerEvents(
  worker: Worker<EvaluationJobData, void, string>,
  eventBus: EvaluationEventBus,
): void {
  const logger = createLogger('EvaluationPublicWorker');

  worker.on('active', (job: Job) => {
    logger.log(`🏃 Job ${job.id} começou a ser processado.`);
    eventBus.emit('evaluation.active', job.data);
  });

  worker.on('completed', (job: Job) => {
    logger.log(`Job ${job.id} terminou com sucesso!`);
  });
}
