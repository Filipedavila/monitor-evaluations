import { EvaluationContext } from '@domains/evaluation/domain/entities/contexts-evaluation.entity';
import { inspectEntity } from 'test/helpers/entity-metadata';

describe('EvaluationContext entity mapping', () => {
  const meta = inspectEntity(EvaluationContext);

  it('maps to the "evaluation_contexts" table', () => {
    expect(meta.tableName).toBe('evaluation_contexts');
  });

  it('uses (context_id, evaluation_id) as composite primary key', () => {
    expect(meta.column('contextId')?.options.primary).toBe(true);
    expect(meta.column('contextId')?.options.name).toBe('context_id');
    expect(meta.column('evaluationId')?.options.primary).toBe(true);
    expect(meta.column('evaluationId')?.options.name).toBe('evaluation_id');
  });

  it.each([
    ['evaluation', 'evaluation_id'],
    ['context', 'context_id'],
  ])('cascades deletion from %s through %s', (property, joinColumnName) => {
    expect(meta.relation(property)?.relationType).toBe('many-to-one');
    expect(meta.relation(property)?.options.onDelete).toBe('CASCADE');
    expect(meta.joinColumn(property)?.name).toBe(joinColumnName);
  });
});
