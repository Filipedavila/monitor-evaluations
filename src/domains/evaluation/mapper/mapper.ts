import { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';

export function toEvaluationDTO(
  evaluationCompleted: Pick<
    EvaluationDTO,
    | 'id'
    | 'pageId'
    | 'pageTitle'
    | 'score'
    | 'A'
    | 'AA'
    | 'AAA'
    | 'tagCount'
    | 'evaluationDate'
    | 'frozenAt'
    | 'createdAt'
    | 'updatedAt'
    | 'createdById'
    | 'updatedById'
  >,
): EvaluationDTO {
  return {
    id: evaluationCompleted.id,
    pageId: evaluationCompleted.pageId,
    pageTitle: evaluationCompleted.pageTitle,
    score: evaluationCompleted.score,
    A: evaluationCompleted.A,
    AA: evaluationCompleted.AA,
    AAA: evaluationCompleted.AAA,
    tagCount: evaluationCompleted.tagCount,
    evaluationDate: evaluationCompleted.evaluationDate,
    frozenAt: evaluationCompleted.frozenAt,
    createdAt: evaluationCompleted.createdAt,
    updatedAt: evaluationCompleted.updatedAt,
    createdById: evaluationCompleted.createdById,
    updatedById: evaluationCompleted.updatedById,
  };
}
