import { EvaluationProducer } from './redis/evaluation.producer';
import { IMetricData } from './types';

export class EvaluationPublishingService {
  constructor(private readonly evaluationProducer: EvaluationProducer) {}

  async execute(metrics: IMetricData[]): Promise<void> {
    await this.publishMetrics(metrics);
  }

  private async publishMetrics(metrics: IMetricData[]): Promise<void> {
    const idPublish = await this.evaluationProducer.publishEvaluations(metrics);
    console.log(`Published evaluation results with ID: ${idPublish}`);
    if (!idPublish) {
      throw new Error('Failed to publish evaluation results to Redis.');
    }
  }
}
