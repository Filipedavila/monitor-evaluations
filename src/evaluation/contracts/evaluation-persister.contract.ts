import { EvaluationScoring, IMetricData } from '../types';

export interface EvaluationPersisterPayload {
  evaluationId: number;
  websiteId: number;
  pageId: number;
  directoryId: number;
  institutionId: number;
  evaluationMetrics: IMetricData[];
  basicResult: EvaluationScoring;
  contextId: number;
}

export interface EvaluationPersister {
  persist(payload: EvaluationPersisterPayload): Promise<void>;
}
