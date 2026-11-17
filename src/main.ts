import './instrumentation';
import './profiler';
import { env } from './config/env';
import { createLogger } from '@infrastructure/logger/logger';
import { createContainer } from './bootstrap/container';
import { setupWorkers } from './bootstrap/worker-manager';
import { createShutdownHandler } from './bootstrap/shutdown';
import { createMemoryGuard } from '@infrastructure/memory-guard/memory-guard';

const logger = createLogger('Bootstrap');

async function bootstrap() {
  logConfigAudit();

  const container = await createContainer(env);
  const { workers, queues } = setupWorkers(container);

  const memoryGuard = createMemoryGuard({
    limitMb: env.MEMORY_HEAP_LIMIT_MB,
    checkIntervalMs: env.MEMORY_GUARD_CHECK_INTERVAL_MS,
    onExceeded: () => {
      logger.warn(
        `Heap usage crossed ${env.MEMORY_HEAP_LIMIT_MB}MB threshold. Stopping job intake and shutting down for a clean restart.`,
      );
      void shutdown('memory-guard');
    },
  });

  const shutdown = createShutdownHandler({
    workers,
    queues,
    redis: container.redis,
    dataSource: container.dataSource,
    memoryGuard,
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
