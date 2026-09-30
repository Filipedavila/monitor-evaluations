import { ruleset } from '@a12e/accessmonitor-rulesets';
import { AuditReport, ConformanceErrors, EvaluationScoring } from './types';

const SEPARATOR = '@';

/**
 * Calculates total number of HTML elements from tags frequency map
 * @param tags - Record mapping tag names to their counts
 * @returns Total count of all elements
 * @throws Error if tags is not an object
 */
export function calculateTotalElements(tags: Record<string, number>): number {
  if (!tags || typeof tags !== 'object') {
    return 0;
  }

  return Object.values(tags).reduce((sum, count) => sum + (count ?? 0), 0);
}

/**
 * Calculates WCAG conformance levels (A, AA, AAA) based on test results
 * @param results - Test results mapping rule IDs to results
 * @returns Formatted string with counts: "A@AA@AAA"
 * @throws Error if results are invalid
 */
export function calculateConform(results: Record<string, unknown>): string {
  const errors: ConformanceErrors = {
    A: 0,
    AA: 0,
    AAA: 0,
  };

  if (!results || typeof results !== 'object') {
    return `${errors.A}${SEPARATOR}${errors.AA}${SEPARATOR}${errors.AAA}`;
  }

  for (const ruleId in results) {
    if (ruleId && ruleset[ruleId]) {
      try {
        const level = ruleset[ruleId].level.toUpperCase() as keyof ConformanceErrors;
        if (ruleset[ruleId].result === 'failed' && level in errors) {
          errors[level]++;
        }
      } catch {
        // Skip invalid rule entries
        continue;
      }
    }
  }

  return `${errors.A}${SEPARATOR}${errors.AA}${SEPARATOR}${errors.AAA}`;
}

/**
 * Calculates HTML page size from encoded content
 * @param html - Raw HTML content
 * @returns Size in encoded URI characters
 */
export function calculatePageSize(html: string): number {
  if (!html || typeof html !== 'string') {
    return 0;
  }
  return encodeURI(html).split(/%..|./).length - 1;
}

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
