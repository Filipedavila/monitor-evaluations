import { EvaluationArtifact } from '@domains/evaluation/domain/entities/evaluation-artifacts.entity';
import { inspectEntity } from 'test/helpers/entity-metadata';

describe('EvaluationArtifact entity mapping', () => {
  const meta = inspectEntity(EvaluationArtifact);

  it('maps to the "evaluation_artifacts" table', () => {
    expect(meta.tableName).toBe('evaluation_artifacts');
  });

  it('uses (evaluation_id, artifact_type) as composite primary key', () => {
    expect(meta.column('evaluationId')?.options.primary).toBe(true);
    expect(meta.column('artifactType')?.options.primary).toBe(true);
    expect(meta.column('storageKey')?.options.primary).toBeUndefined();
  });

  it.each([
    ['evaluationId', 'evaluation_id'],
    ['artifactType', 'artifact_type'],
    ['storageKey', 'storage_key'],
    ['fileSize', 'file_size'],
    ['mimeType', 'mime_type'],
    ['createdAt', 'created_at'],
    ['ETag', 'etag'],
  ])('maps property %s to column %s', (property, columnName) => {
    expect(meta.column(property)?.options.name).toBe(columnName);
  });

  it('requires a unique storage key', () => {
    expect(meta.column('storageKey')?.options.unique).toBe(true);
  });

  it('stores file_size as bigint', () => {
    expect(meta.column('fileSize')?.options.type).toBe('bigint');
  });

  it('allows a missing ETag', () => {
    expect(meta.column('ETag')?.options.nullable).toBe(true);
  });

  it('fills created_at automatically', () => {
    expect(meta.column('createdAt')?.mode).toBe('createDate');
  });

  it('cascades deletion from the evaluation', () => {
    expect(meta.relation('evaluation')?.relationType).toBe('many-to-one');
    expect(meta.relation('evaluation')?.options.onDelete).toBe('CASCADE');
    expect(meta.joinColumn('evaluation')?.name).toBe('evaluation_id');
  });
});
