import { Job, Queue, Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { EvaluationEngine } from '../../contracts/evaluation-engine.contract';
import { EvaluationStorage } from '../../contracts/evaluation-storage.contract';
import { EvaluationPersister } from '../../contracts/evaluation-persister.contract';
import { EvaluationJobData } from '../../types';
import { EvaluationParserService } from '../../evaluation-parser.service';
import { EvaluationRepository } from '../../evaluation.repository';
import { Evaluation } from '../../entities/evaluation.entity';
import { PageStatus } from '../../evaluation.constants';
import { EvaluationEventBus } from '../../../events/evaluation-events';
import { createLogger } from '../../../logger/logger';

const CONTEXT_ID = 1;

type CompensationAction = () => Promise<void>;

export interface EvaluationPrivateWorkerDeps {
  dlqQueue: Queue;
  evaluationEngine: EvaluationEngine;
  evaluationStore: EvaluationStorage;
  evaluationParser: EvaluationParserService;
  evaluationPersister: EvaluationPersister;
  evaluationRepository: EvaluationRepository;
  eventBus: EvaluationEventBus;
  dataSource: DataSource;
}

export function createEvaluationPrivateProcessor(deps: EvaluationPrivateWorkerDeps) {
  const logger = createLogger('EvaluationPrivateWorker');

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
        error: {
          message: error.message,
          stack: error.stack,
        },
        failedAt: new Date().toISOString(),
      });
    } catch (dlqError) {
      const errorMessage = dlqError instanceof Error ? dlqError.message : String(dlqError);
      logger.error(`Failed to push job ${job.id} to DLQ: ${errorMessage}`);
    }

    try {
      await deps.dataSource.query(
        `
        UPDATE page_contexts_ams
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
      const errorMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logger.error(
        `Falha ao marcar status FAILED para a página ${job.data.pageId}: ${errorMessage}`,
      );
    }
  }

  return async function process(job: Job<EvaluationJobData, void, string>): Promise<void> {
    const { institutionId, evaluationId, directoryIds, websiteId, pageId, url } = job.data;
    let evaluationIdJob = evaluationId;

    const compensations: CompensationAction[] = [];

    try {
      // 1. Executa avaliação e regras
      const rawReport = await deps.evaluationEngine.evaluate(url);
      if (!rawReport) throw Error('Evaluation Engine returned no result');

      await job.updateProgress(30);

      // 2. Normaliza o relatório e extrai as entidades de domínio
      const { evaluationReport, evaluationData } =
        deps.evaluationParser.parseEvaluation(rawReport);
      const evaluationDate = evaluationReport.metadata.evaluatedAt;

      // 3. Persistência relacional inicial
      if (!evaluationIdJob) {
        const evaluation = new Evaluation();
        evaluation.evaluationDate = new Date(evaluationDate);
        evaluation.pageId = pageId;

        const created = await deps.evaluationRepository.createEvaluation(evaluation, CONTEXT_ID);
        evaluationIdJob = created.id;

        compensations.push(async () => {
          logger.warn(`Compensação: A apagar evaluation ${evaluationIdJob} da BD...`);
          await deps.evaluationRepository.delete(evaluationIdJob!);
        });

        await job.updateData({
          ...job.data,
          evaluationId: evaluationIdJob,
        });
      }

      // 4. Métricas de ingestão
      const ingestionMetrics = deps.evaluationParser.parseIngestionMetrics(
        evaluationIdJob,
        directoryIds,
        institutionId,
        websiteId,
        pageId,
        evaluationReport.scoring.score,
        evaluationDate,
        evaluationReport.scoring.rulesOccurrences,
      );

      if (!ingestionMetrics) throw Error('Evaluation Parser returned no ingestion metrics');
      await job.updateProgress(60);

      const storageEvaluationDate = new Date(evaluationDate).toISOString().slice(0, 10);

      // 5. Envia os artefactos da avaliação (HTML + evidências) para o storage
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

      compensations.push(async () => {
        logger.warn(
          `Compensação: A apagar ficheiros do storage para evaluation ${evaluationIdJob}...`,
        );
        await deps.evaluationStore.delete({
          evaluationId: evaluationIdJob!,
          websiteId,
          pageId,
          evaluationDate: storageEvaluationDate,
        });
      });

      await job.updateProgress(80);

      // 6. Persistência de métricas agregadas (ClickHouse / OLAP)
      await deps.evaluationPersister.persist({
        evaluationId: evaluationIdJob,
        websiteId,
        directoryId: directoryIds[0],
        pageId,
        institutionId,
        evaluationMetrics: ingestionMetrics,
        basicResult: evaluationData,
        contextId: CONTEXT_ID,
      });

      // 7. Atualização do status da página
      await deps.dataSource.query(
        `
        UPDATE page_contexts_ams
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

export function attachEvaluationPrivateWorkerEvents(
  worker: Worker<EvaluationJobData, void, string>,
  eventBus: EvaluationEventBus,
): void {
  const logger = createLogger('EvaluationPrivateWorker');

  worker.on('active', (job: Job) => {
    logger.log(`🏃 Job ${job.id} começou a ser processado.`);
    eventBus.emit('evaluation.active', job.data);
  });

  worker.on('completed', (job: Job) => {
    logger.log(`Job ${job.id} terminou com sucesso!`);
  });
}
