import {
  EvaluationPublisher,
  PublishEvaluationMetricsPayload,
} from '@evaluation/contracts/evaluation-publisher.contract';
import { EvaluationPublishingService } from '@evaluation/application/evaluation-publish.service';
import { Logger } from '@infrastructure/logger/logger';

export class EvaluationStreamStrategy implements EvaluationPublisher {
  constructor(
    private readonly evaluationPublishingService: EvaluationPublishingService,
    private readonly logger: Logger,
  ) {}

  async publishMetrics(payload: PublishEvaluationMetricsPayload): Promise<void> {
    const { evaluationId, metrics } = payload;

    try {
      this.logger.log(`Starting metrics streaming to Redis for Evaluation ID: ${evaluationId}`);
      await this.evaluationPublishingService.execute(metrics);
    } catch (error) {
      this.logger.error(`Failed to stream to redis with Evaluation ID: ${evaluationId}`, error);
      throw error;
    }
  }
}
