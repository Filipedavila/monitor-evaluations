import { DataSource, QueryRunner, Repository } from 'typeorm';
import { Evaluation } from '@evaluation/domain/entities/evaluation.entity';
import { EvaluationContext } from '@evaluation/domain/entities/contexts-evaluation.entity';
import { EvaluationScoring } from '@evaluation/types';
import { PageStatus } from '@evaluation/domain/evaluation.constants';
export class EvaluationNotFoundError extends Error {
  constructor(evaluationId: number) {
    super(`Evaluation with ID ${evaluationId} not found`);
    this.name = 'EvaluationNotFoundError';
  }
}

export class EvaluationRepository {
  constructor(
    private readonly ormRepo: Repository<Evaluation>,
    private readonly dataSource: DataSource,
  ) {}

  async runInTransaction<T>(work: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const result = await work(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async upsertEvaluation(evaluation: Evaluation, contextId: number): Promise<Evaluation> {
    return await this.dataSource.transaction(async (manager) => {
      const savedEval = await manager.getRepository(Evaluation).save(evaluation);

      await manager
        .createQueryBuilder()
        .insert()
        .into(EvaluationContext)
        .values({
          evaluationId: savedEval.id,
          contextId,
        })
        .orUpdate(['context_id'], ['evaluation_id', 'context_id'])
        .execute();

      return savedEval;
    });
  }

  async delete(evaluationId: number): Promise<void> {
    await this.ormRepo.delete({ id: evaluationId });
  }

  async findByIdOrFail(evaluationId: number): Promise<Evaluation> {
    const evaluation = await this.ormRepo.findOne({ where: { id: evaluationId } });
    if (!evaluation) {
      throw new EvaluationNotFoundError(evaluationId);
    }
    return evaluation;
  }

  async updateEntityFromRawData(
    evaluationId: number,
    evaluationData: EvaluationScoring,
  ): Promise<Evaluation> {
    const evaluation = await this.findByIdOrFail(evaluationId);
    evaluation.pageTitle = evaluationData.title;
    evaluation.A = evaluationData.A;
    evaluation.AA = evaluationData.AA;
    evaluation.AAA = evaluationData.AAA;
    evaluation.score = evaluationData.score;
    evaluation.createdAt = new Date(evaluationData.createdAt);
    evaluation.updatedAt = new Date(evaluationData.createdAt);
    return await this.ormRepo.save(evaluation);
  }

  async completeEvaluation(
    evaluationId: number,
    evaluationData: EvaluationScoring,
    pageContextTable: string,
    pageId: number,
  ): Promise<Evaluation> {
    return await this.runInTransaction(async (queryRunner) => {
      const evaluation = await this.findByIdOrFail(evaluationId);
      evaluation.pageTitle = evaluationData.title;
      evaluation.A = evaluationData.A;
      evaluation.AA = evaluationData.AA;
      evaluation.AAA = evaluationData.AAA;
      evaluation.score = evaluationData.score;
      evaluation.createdAt = new Date(evaluationData.createdAt);
      evaluation.updatedAt = new Date(evaluationData.createdAt);
      const savedEvaluation = await queryRunner.manager.save(evaluation);
      await queryRunner.manager.query(
        `
      UPDATE ${pageContextTable}
      SET page_status = $1
      WHERE page_id = $2;
      `,
        [PageStatus.EVALUATED, pageId],
      );

      return savedEvaluation;
    });
  }
}
