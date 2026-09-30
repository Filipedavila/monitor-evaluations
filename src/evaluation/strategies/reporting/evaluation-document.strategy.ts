import { PublishStatus } from '../../entities/evaluation.entity';
import {
  EvaluationPersister,
  EvaluationPersisterPayload,
} from '../../contracts/evaluation-persister.contract';
import { EvaluationRepository } from '../../evaluation.repository';
import { EvaluationPublishingService } from '../../evaluation-publish.service';
import { Evaluation } from '../../entities/evaluation.entity';
import { Logger } from '../../../logger/logger';

export class EvaluationDocumentStrategy implements EvaluationPersister {
  constructor(
    private readonly evaluationRepository: EvaluationRepository,
    private readonly evaluationPublishingService: EvaluationPublishingService,
    private readonly logger: Logger,
  ) {}

  async persist(payload: EvaluationPersisterPayload): Promise<void> {
    const { evaluationId, evaluationMetrics, basicResult, pageId } = payload;

    try {
      this.logger.log(`Starting document persistence workflow for Evaluation ID: ${evaluationId}`);

      await this.evaluationRepository.runInTransaction(async (queryRunner) => {
        // TODO: needs to be UPSERT

        // TODO : ATTENTION , FOR TESTING PURPOSE ONLY.. SHOULD BE PUT IN OUTBOX TO GARANTY AT LEAST ONCE DELIVERY
        await this.evaluationPublishingService.execute(evaluationMetrics);

        await queryRunner.manager.upsert(
          Evaluation,
          {
            id: evaluationId,
            pageTitle: basicResult.title,
            pageId: pageId,
            A: basicResult.A,
            AA: basicResult.AA,
            AAA: basicResult.AAA,
            evaluationDate: new Date(basicResult.createdAt),
            status: PublishStatus.STAGED,
            score: basicResult.score,
            tagCount: basicResult.tagCount,
          },
          ['id'],
        );
      });
    } catch (error) {
      this.logger.error(`Failed to persist evaluation data for ID: ${evaluationId}`, error);
      throw error;
    }
  }
}
