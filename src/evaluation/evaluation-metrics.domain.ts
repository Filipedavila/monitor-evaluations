import { AuditReport, EvaluationScoring } from './types';

const toSafeCount = (val: unknown): number => {
  const num = Number(val);
  return Number.isFinite(num) ? num : 0;
};

export function createEvaluationEntity(report: AuditReport): EvaluationScoring {
  const rawTitle = report.metadata.title;
  const rawConform = report.scoring.conform as string;
  const score = report.scoring.score;
  const createdAt = report.metadata.evaluatedAt;

  const title = rawTitle.replace(/"/g, '').replace(/[\u0800-\uFFFF]/g, '');

  const conform = (rawConform || '0@0@0').split('@');

  return {
    title,
    score: String(score ?? ''),
    A: toSafeCount(conform[0]),
    AA: toSafeCount(conform[1]),
    AAA: toSafeCount(conform[2]),
    createdAt: createdAt,
    tagCount: report.telemetry.totalHtmlTags,
  };
}
