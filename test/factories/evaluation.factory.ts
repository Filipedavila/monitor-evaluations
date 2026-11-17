import { DataSource, DeepPartial } from 'typeorm';
import { Evaluation } from '@domains/evaluation/domain/entities/evaluation.entity';
import {
  ArtifactType,
  EvaluationArtifact,
} from '@domains/evaluation/domain/entities/evaluation-artifacts.entity';
import { EvaluationContext } from '@domains/evaluation/domain/entities/contexts-evaluation.entity';
import { Page } from '@domains/inventory/page/page.entity';
import { User } from '@domains/identity/user/user.entity';
import { Context } from '@domains/inventory/context/context.identity';

let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export async function createUser(ds: DataSource, overrides: Partial<User> = {}): Promise<User> {
  const repository = ds.getRepository(User);
  return repository.save(repository.create({ username: `user-${nextSequence()}`, ...overrides }));
}

export async function createPage(ds: DataSource, overrides: Partial<Page> = {}): Promise<Page> {
  const repository = ds.getRepository(Page);
  const n = nextSequence();
  return repository.save(
    repository.create({ url: `https://example.com/page-${n}`, websiteId: 1, ...overrides }),
  );
}

export async function createContext(
  ds: DataSource,
  overrides: Partial<Context> = {},
): Promise<Context> {
  const repository = ds.getRepository(Context);
  return repository.save(repository.create({ code: `ctx-${nextSequence()}`, ...overrides }));
}

export async function createEvaluation(
  ds: DataSource,
  overrides: DeepPartial<Evaluation> = {},
): Promise<Evaluation> {
  const pageId = overrides.pageId ?? (await createPage(ds)).id;
  const repository = ds.getRepository(Evaluation);

  return repository.save(
    repository.create({
      evaluationDate: new Date('2024-01-01T00:00:00.000Z'),
      ...overrides,
      pageId,
    }),
  );
}

type ArtifactValues = Pick<
  EvaluationArtifact,
  'evaluationId' | 'artifactType' | 'storageKey' | 'fileSize' | 'mimeType' | 'ETag'
>;

function artifactValues(
  evaluationId: number,
  overrides: Partial<EvaluationArtifact>,
): ArtifactValues {
  const artifactType: ArtifactType = overrides.artifactType ?? 'html';
  return {
    evaluationId,
    artifactType,
    storageKey: `evaluations/${evaluationId}/${artifactType}-${nextSequence()}.gz`,
    fileSize: 1024,
    mimeType: 'application/gzip',
    ETag: 'etag-default',
    ...overrides,
  };
}

export async function createArtifact(
  ds: DataSource,
  evaluationId: number,
  overrides: Partial<EvaluationArtifact> = {},
): Promise<EvaluationArtifact> {
  const repository = ds.getRepository(EvaluationArtifact);
  return repository.save(repository.create(artifactValues(evaluationId, overrides)));
}

export async function insertArtifact(
  ds: DataSource,
  evaluationId: number,
  overrides: Partial<EvaluationArtifact> = {},
): Promise<void> {
  await ds.getRepository(EvaluationArtifact).insert(artifactValues(evaluationId, overrides));
}

export async function linkEvaluationToContext(
  ds: DataSource,
  evaluationId: number,
  contextId: number,
): Promise<EvaluationContext> {
  const repository = ds.getRepository(EvaluationContext);
  return repository.save(repository.create({ evaluationId, contextId }));
}
