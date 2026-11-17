import { EvaluationPipeline } from '../shared/worker.types';
import { Evaluation } from '@evaluation/domain/entities/evaluation.entity';
import { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';
import { toEvaluationDTO } from '@evaluation/mapper/mapper';
import { EvaluationPrivateWorkerDeps } from './rollback-executor.private';

export function createPrivatePipeline(
  deps: EvaluationPrivateWorkerDeps,
): EvaluationPipeline<EvaluationDTO> {
  return async (job, { config, journal, steps }) => {
    const { institutionId, directoryIds, websiteId, pageId, url, userId } = job.data;

    // 1. Engine
    const rawReport = await steps.evaluateOrThrow(url);
    await job.updateProgress(30);

    // 2. Parse
    const { evaluationReport, evaluationData } = deps.evaluationParser.parseEvaluation(rawReport);
    const evaluationDate = evaluationReport.metadata.evaluatedAt;

    // 3. Regista a evaluation (reaproveita o id num retry)
    const isNewEvaluation = !job.data.evaluationId;

    const evaluation = new Evaluation();
    evaluation.evaluationDate = new Date(evaluationDate);
    evaluation.pageId = pageId;
    if (userId) evaluation.createdById = userId;
    if (job.data.evaluationId) evaluation.id = job.data.evaluationId;

    const created = await deps.evaluationRepository.upsertEvaluation(evaluation, config.contextId);
    const evaluationId = created.id;

    if (isNewEvaluation) await journal.recordCreatedEvaluation(evaluationId);

    // 4. Métricas de ingestão
    const ingestionMetrics = deps.evaluationParser.parseIngestionMetrics(
      evaluationId,
      directoryIds,
      institutionId,
      websiteId,
      pageId,
      evaluationReport.scoring.score,
      evaluationDate,
      evaluationReport.scoring.rulesOccurrences,
    );
    if (!ingestionMetrics) throw new Error('Evaluation Parser returned no ingestion metrics');
    await job.updateProgress(60);

    // 5. Storage (HTML + evidências; o journal é atualizado antes de escrever)
    await steps.saveToStorage(job, evaluationId, evaluationDate, evaluationReport, journal);
    await job.updateProgress(80);

    // 6. Complete evaluation in the repository
    const evaluationCompleted = await deps.evaluationRepository.completeEvaluation(
      evaluationId,
      evaluationData,
      config.pageTable,
      pageId,
    );

    // 7. Persistencia Redis strea, necessita rollback
    await deps.evaluationPersister.publishMetrics({
      evaluationId,
      metrics: ingestionMetrics,
    });

    await job.updateProgress(100);
    job.log('Evaluation Resolution Ended');

    deps.eventBus.emit('evaluation.completed', { ...job.data, evaluationId });
    return toEvaluationDTO(evaluationCompleted);
  };
}
