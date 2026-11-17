import { Evaluation } from '@domains/evaluation/domain/entities/evaluation.entity';
import { inspectEntity } from '../../../../helpers/entity-metadata';

describe('Evaluation entity', () => {
  describe('isFrozen', () => {
    function buildEvaluation(frozenAt: Date | null): Evaluation {
      const evaluation = new Evaluation();
      evaluation.frozenAt = frozenAt;
      return evaluation;
    }

    it('is false when frozenAt is null', () => {
      expect(buildEvaluation(null).isFrozen).toBe(false);
    });

    it('is true when frozenAt holds a date', () => {
      expect(buildEvaluation(new Date('2024-06-01T12:00:00.000Z')).isFrozen).toBe(true);
    });

    it('is true for the epoch date', () => {
      expect(buildEvaluation(new Date(0)).isFrozen).toBe(true);
    });

    it('reflects later changes to frozenAt', () => {
      const evaluation = buildEvaluation(null);

      evaluation.frozenAt = new Date();
      expect(evaluation.isFrozen).toBe(true);

      evaluation.frozenAt = null;
      expect(evaluation.isFrozen).toBe(false);
    });
  });

  describe('mapping metadata', () => {
    const meta = inspectEntity(Evaluation);

    it('maps to the "evaluations" table', () => {
      expect(meta.tableName).toBe('evaluations');
    });

    it('uses an identity primary key', () => {
      expect(meta.column('id')?.options.primary).toBe(true);
      expect(meta.generation('id')?.strategy).toBe('identity');
    });

    it.each([
      ['pageId', 'page_id'],
      ['pageTitle', 'page_title'],
      ['score', 'score'],
      ['tagCount', 'tag_count'],
      ['evaluationDate', 'evaluation_date'],
      ['frozenAt', 'frozen_at'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
      ['createdById', 'created_by_id'],
      ['updatedById', 'updated_by_id'],
    ])('maps property %s to column %s', (property, columnName) => {
      expect(meta.column(property)?.options.name).toBe(columnName);
    });
  });
});
