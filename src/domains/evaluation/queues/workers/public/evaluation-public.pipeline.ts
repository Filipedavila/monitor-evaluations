import { Evaluation } from '../../../domain/entities/evaluation.entity';
import { toEvaluationDTO } from '@evaluation/mapper/mapper';
import { EvaluationPublicWorkerDeps } from './evaluation-public.worker';
import { EvaluationPipeline } from '../shared/worker.types';
import { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';

export function createPublicPipeline(
  deps: EvaluationPublicWorkerDeps,
): EvaluationPipeline<EvaluationDTO> {
  return async (job, { config, journal, steps }) => {
    const { pageId, url } = job.data;

    // 1. Engine
    const rawResult = await steps.evaluateOrThrow(url);
    await job.updateProgress(50);
    job.log('Received Evaluation from Engine');

    // 2. Parse
    const { evaluationReport, evaluationData } = deps.evaluationParser.parseEvaluation(rawResult);
    const evaluationDate = evaluationReport.metadata.evaluatedAt;

    // 3. Cria o registo só se ainda não existir (um retry reaproveita o id guardado no job)
    let evaluationId = job.data.evaluationId;
    if (!evaluationId) {
      const newEvaluation = new Evaluation();
      newEvaluation.evaluationDate = new Date(evaluationDate);
      newEvaluation.pageId = pageId;

      const created = await deps.evaluationRepository.upsertEvaluation(
        newEvaluation,
        config.contextId,
      );
      evaluationId = created.id;

      // Grava no job o id e a marca "criado por este job" (usada no rollback)
      await journal.recordCreatedEvaluation(evaluationId);
    }

    // 4. Storage (o journal é atualizado antes de escrever)
    await steps.saveToStorage(job, evaluationId, evaluationDate, evaluationReport, journal);
    job.log('Saved compressed files in Storage');
    await job.updateProgress(70);

    // 5. Persistência na BD relacional
    const evaluationCompleted = await deps.evaluationRepository.completeEvaluation(
      evaluationId,
      evaluationData,
      config.pageTable,
      pageId,
    );

    // 6. Estado da página + evento
    await job.updateProgress(100);
    job.log('Evaluation Resolution Ended');

    deps.eventBus.emit('evaluation.completed', { ...job.data, evaluationId });

    return toEvaluationDTO(evaluationCompleted);
  };
}
