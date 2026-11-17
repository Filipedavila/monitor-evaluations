import { IMetricData } from '../types';

export interface PublishEvaluationMetricsPayload {
  evaluationId: number;
  metrics: IMetricData[];
}

export interface EvaluationPublisher {
  publishMetrics(payload: PublishEvaluationMetricsPayload): Promise<void>;
}
