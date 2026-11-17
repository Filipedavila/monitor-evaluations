import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { createLogger } from '@infrastructure/logger/logger';
import { createDataSource } from '@infrastructure/database/data-source';
import { createRedisClient } from '@infrastructure/redis/redis-client';
import { createQueueConnection } from '@infrastructure/queues/connection';
import { EvaluationEventBus } from '../events/evaluation-events';
import { Evaluation } from '@evaluation/domain/entities/evaluation.entity';
import { EvaluationArtifact } from '@evaluation/domain/entities/evaluation-artifacts.entity';
import { EvaluationRepository } from '@evaluation/infrastructure/persistence/evaluation.repository';
import { EvaluationParserService } from '@evaluation/application/evaluation-parser.service';
import { EvaluationPublishingService } from '@evaluation/application/evaluation-publish.service';
import { EvaluationProducer } from '@evaluation/infrastructure/messaging/evaluation.producer';
import { QualWebPuppeteerEngine } from '@evaluation/infrastructure/engines/evaluation-engine-puppeteer.strategy';
import { QualWebPlaywrightEngine } from '@evaluation/infrastructure/engines/evaluation-engine-playwright.strategy';
import { EvaluationStreamStrategy } from '@evaluation/infrastructure/messaging/evaluation-stream.strategy';
import { EvaluationS3StorageStrategy } from '@evaluation/infrastructure/storage/evaluation-s3-aws-storage.strategy';
import { EvaluationEngine } from '@/domains/evaluation/contracts/evaluation-engine.contract';

export interface AppContainer {
  dataSource: DataSource;
  redis: Redis;
  connection: ReturnType<typeof createQueueConnection>;
  eventBus: EvaluationEventBus;
  evaluationEngine: EvaluationEngine;
  evaluationStore: EvaluationS3StorageStrategy;
  evaluationParser: EvaluationParserService;
  evaluationPersister: EvaluationStreamStrategy;
  evaluationRepository: EvaluationRepository;
}

export async function createContainer(env: Env): Promise<AppContainer> {
  const logger = createLogger('Container');

  const dataSource = createDataSource(env);
  await dataSource.initialize();

  const redis = createRedisClient(env);
  const connection = createQueueConnection(env);
  const eventBus = new EvaluationEventBus();

  const evaluationParser = new EvaluationParserService(createLogger('EvaluationParserService'));
  const evaluationRepository = new EvaluationRepository(
    dataSource.getRepository(Evaluation),
    dataSource,
  );
  const evaluationArtifactRepository = dataSource.getRepository(EvaluationArtifact);
  const evaluationProducer = new EvaluationProducer(redis);
  const evaluationPublishingService = new EvaluationPublishingService(evaluationProducer);
  const evaluationEngine = new QualWebPuppeteerEngine();

  const evaluationStore = new EvaluationS3StorageStrategy(
    createLogger('EvaluationAwsS3Strategy'),
    evaluationArtifactRepository,
  );
  await evaluationStore.init();

  const evaluationPersister = new EvaluationStreamStrategy(
    evaluationPublishingService,
    createLogger('EvaluationDocumentStrategy'),
  );

  logger.log('Dependency injection container initialized successfully.');

  return {
    dataSource,
    redis,
    connection,
    eventBus,
    evaluationEngine,
    evaluationStore,
    evaluationParser,
    evaluationPersister,
    evaluationRepository,
  };
}
