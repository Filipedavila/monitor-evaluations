import {
  processEvaluation,
  getRuleMetadata,
  EvaluationProcessingResult,
} from '@a12e/accessmonitor-rulesets';
import { createEvaluationEntity } from './evaluation-metrics.domain';
import { generateMd5Hash } from '../common/utils/crypto';
import {
  AuditReport,
  ConformanceResultToken,
  ConformanceToken,
  EvaluationScoring,
  IMetricData,
} from './types';
import { Logger } from '../logger/logger';

export class EvaluationParserService {
  constructor(private readonly logger: Logger) {}

  public parseEvaluation(rawReport: any): {
    evaluationReport: AuditReport;
    evaluationData: EvaluationScoring;
  } {
    if (!rawReport || typeof rawReport !== 'object') {
      throw new Error('Invalid evaluation: evaluation payload must be a non-null object.');
    }

    if (!rawReport.system || !rawReport.system.page || !rawReport.system.page.dom) {
      throw new Error(
        `Invalid QualWeb payload structure for job: missing 'system.page.dom'. Raw payload type: ${rawReport.type || 'unknown'}`,
      );
    }

    try {
      const evaluationProcessed: EvaluationProcessingResult = processEvaluation(rawReport);
      const hash = generateMd5Hash(evaluationProcessed.metadata.metadata.evaluatedAt);

      const evaluationReport: AuditReport = {
        metadata: evaluationProcessed.metadata.metadata,
        snapshot: {
          html: evaluationProcessed.html.html,
          sizeInBytes: evaluationProcessed.html.pageSize,
          hash,
        },
        telemetry: {
          elementCounters: evaluationProcessed.elementCounters,
          roles: evaluationProcessed.metadata.telemetry.roles,
          tagCounter: evaluationProcessed.metadata.telemetry.tagCounter,
          totalHtmlTags: evaluationProcessed.metadata.telemetry.totalHtmlTags,
        },
        scoring: {
          conform: evaluationProcessed.scoreDetails.conform as ConformanceToken,
          totalTests: evaluationProcessed.scoreDetails.totalTests,
          score: evaluationProcessed.scoreDetails.score,
          rulesOccurrences: evaluationProcessed.rulesOccurrences,
          assertionEvidence: evaluationProcessed.assertionEvidence,
          conformanceResults: evaluationProcessed.conformanceResults as Record<
            string,
            ConformanceResultToken
          >,
        },
      };

      const evaluationData = createEvaluationEntity(evaluationReport);

      return { evaluationReport, evaluationData };
    } catch (error) {
      throw new Error(
        `Failed to parse evaluation entity: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  public parseIngestionMetrics(
    evaluationId: number,
    directoryIds: number[],
    institutionId: number,
    websiteId: number,
    pageId: number,
    score: string,
    evaluationDate: string,
    metrics: Record<string, number>,
  ): IMetricData[] {
    return Object.entries(metrics)
      .map(([key, value]) => {
        try {
          const { rule_id, rule_result } = getRuleMetadata(key);
          return {
            evaluation_id: evaluationId,
            directories_ids: directoryIds,
            institution_id: institutionId,
            website_id: websiteId,
            page_id: pageId,
            evaluation_date: evaluationDate,
            score: Number(score),
            rule_id: rule_id,
            count: Number(value),
            rule_result: rule_result,
          };
        } catch (error) {
          this.logger.error(
            `Failed to parse metric for rule ${key}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      })
      .filter((item) => item !== null);
  }
}
