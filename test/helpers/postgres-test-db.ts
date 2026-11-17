import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { Evaluation } from '@domains/evaluation/domain/entities/evaluation.entity';
import { EvaluationArtifact } from '@domains/evaluation/domain/entities/evaluation-artifacts.entity';
import { EvaluationContext } from '@domains/evaluation/domain/entities/contexts-evaluation.entity';
import { Page } from '@domains/inventory/page/page.entity';
import { User } from '@domains/identity/user/user.entity';
import { Context } from '@domains/inventory/context/context.identity';

const POSTGRES_IMAGE = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine';

export const TEST_ENTITIES = [
  Evaluation,
  EvaluationArtifact,
  EvaluationContext,
  Page,
  User,
  Context,
];

export interface TestDatabase {
  readonly dataSource: DataSource;
  /** Removes all rows from every mapped table and resets identity sequences. */
  truncateAll(): Promise<void>;
  /** Destroys the connection and stops the container. */
  stop(): Promise<void>;
}

/**
 * Starts an ephemeral PostgreSQL container and a TypeORM DataSource whose schema
 * is generated from the entities (synchronize). One instance per test suite.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

  const dataSource = new DataSource({
    type: 'postgres',
    url: container.getConnectionUri(),
    entities: TEST_ENTITIES,
    synchronize: true,
    dropSchema: true,
    logging: false,
  });

  try {
    await dataSource.initialize();
  } catch (error) {
    await container.stop();
    throw error;
  }

  const tableList = dataSource.entityMetadatas
    .map((metadata) => dataSource.driver.escape(metadata.tableName))
    .join(', ');

  return {
    dataSource,
    async truncateAll(): Promise<void> {
      await dataSource.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    },
    async stop(): Promise<void> {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      await container.stop();
    },
  };
}
