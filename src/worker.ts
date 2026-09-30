import './profiler';
import { Queue, Worker } from 'bullmq';
import { env } from './config/env';
import { createLogger } from './logger/logger';
import { createDataSource } from './database/data-source';
import { createRedisClient } from './redis/redis-client';
import { createQueueConnection } from './queues/connection';
import { QUEUE_NAMES } from './queues/queues.config';
import { createMemoryGuard, MemoryGuard } from './memory-guard/memory-guard';
import { EvaluationEventBus } from './events/evaluation-events';

import { Evaluation } from './evaluation/entities/evaluation.entity';
import { EvaluationRepository } from './evaluation/evaluation.repository';
import { EvaluationParserService } from './evaluation/evaluation-parser.service';
import { EvaluationPublishingService } from './evaluation/evaluation-publish.service';
import { EvaluationProducer } from './evaluation/redis/evaluation.producer';
import { QualWebPuppeteerEngine } from './evaluation/strategies/engines/evaluation-engine-puppeteer.strategy';
import { EvaluationLocalStorageStrategy } from './evaluation/strategies/storage/evaluation-local-storage.strategy';
import { EvaluationDocumentStrategy } from './evaluation/strategies/reporting/evaluation-document.strategy';
import {
  createEvaluationPrivateProcessor,
  attachEvaluationPrivateWorkerEvents,
} from './evaluation/queue/workers/evaluation-private.worker';
import {
  createEvaluationPublicProcessor,
  attachEvaluationPublicWorkerEvents,
} from './evaluation/queue/workers/evaluation-public.worker';

const logger = createLogger('Bootstrap');

async function bootstrap() {
  logConfigAudit();

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
  const evaluationProducer = new EvaluationProducer(redis);
  const evaluationPublishingService = new EvaluationPublishingService(evaluationProducer);
  const evaluationEngine = new QualWebPuppeteerEngine();
  const evaluationStore = new EvaluationLocalStorageStrategy(
    createLogger('EvaluationLocalStorageStrategy'),
  );
  await evaluationStore.init();
  const evaluationPersister = new EvaluationDocumentStrategy(
    evaluationRepository,
    evaluationPublishingService,
    createLogger('EvaluationDocumentStrategy'),
  );

  const privateDlqQueue = new Queue(QUEUE_NAMES.EVAL_PRIVATE_DLQ, { connection });
  const publicDlqQueue = new Queue(QUEUE_NAMES.EVAL_PUBLIC_DLQ, { connection });

  const privateProcessor = createEvaluationPrivateProcessor({
    dlqQueue: privateDlqQueue,
    evaluationEngine,
    evaluationStore,
    evaluationParser,
    evaluationPersister,
    evaluationRepository,
    eventBus,
    dataSource,
  });

  const publicProcessor = createEvaluationPublicProcessor({
    dlqQueue: publicDlqQueue,
    evaluationEngine,
    evaluationStore,
    evaluationParser,
    evaluationRepository,
    eventBus,
    dataSource,
  });

  const privateWorker = new Worker(QUEUE_NAMES.EVAL_PRIVATE, privateProcessor, {
    connection,
    concurrency: 2,
    lockDuration: 180000,
  });
  attachEvaluationPrivateWorkerEvents(privateWorker, eventBus);

  const publicWorker = new Worker(QUEUE_NAMES.EVAL_PUBLIC, publicProcessor, {
    connection,
    concurrency: 2,
    lockDuration: 180000,
  });
  attachEvaluationPublicWorkerEvents(publicWorker, eventBus);

  const workers = [privateWorker, publicWorker];
  const dlqQueues = [privateDlqQueue, publicDlqQueue];

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn(`Shutting down gracefully (${reason})...`);
    memoryGuard.stop();

    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(dlqQueues.map((queue) => queue.close()));
    await redis.quit();
    await dataSource.destroy();

    logger.log('Shutdown complete.');
    process.exit(0);
  };

  const memoryGuard: MemoryGuard = createMemoryGuard({
    limitMb: env.MEMORY_HEAP_LIMIT_MB,
    checkIntervalMs: env.MEMORY_GUARD_CHECK_INTERVAL_MS,
    onExceeded: () => {
      logger.warn(
        `Heap usage crossed ${env.MEMORY_HEAP_LIMIT_MB}MB threshold. Stopping job intake and shutting down for a clean restart.`,
      );
      void shutdown('memory-guard');
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.log('Worker started. Listening for evaluation jobs.');
}

function logConfigAudit(): void {
  const configs = [
    { label: 'NODE_ENV', value: env.NODE_ENV },
    { label: 'REDIS_HOST', value: env.REDIS_HOST },
    { label: 'REDIS_PORT', value: env.REDIS_PORT },
    { label: 'DB_HOST', value: env.DB_HOST },
    { label: 'DB_PORT', value: env.DB_PORT },
    { label: 'DB_USERNAME', value: env.DB_USERNAME },
    { label: 'DB_DATABASE', value: env.DB_DATABASE },
    { label: 'MEMORY_HEAP_LIMIT_MB', value: env.MEMORY_HEAP_LIMIT_MB },
  ];

  logger.log('┌──────────────────────────────────────────┐');
  logger.log('│          CONFIGURATION AUDIT             │');
  logger.log('├──────────────────────────────────────────┤');
  configs.forEach((config) => {
    logger.log(`│ ${config.label.padEnd(20)} : ${String(config.value).padEnd(18)} │`);
  });
  logger.log('└──────────────────────────────────────────┘');
}

bootstrap().catch((error) => {
  logger.error('Fatal error during worker bootstrap', error);
  process.exit(1);
});
