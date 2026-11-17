import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { MemoryGuard } from '@infrastructure/memory-guard/memory-guard';
import { createLogger } from '@infrastructure/logger/logger';

const logger = createLogger('ShutdownManager');

interface ShutdownContext {
  workers: Worker[];
  queues: Queue[];
  redis: Redis;
  dataSource: DataSource;
  memoryGuard: MemoryGuard;
}

export function createShutdownHandler(context: ShutdownContext) {
  let shuttingDown = false;

  return async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn(`Shutting down gracefully (${reason})...`);
    context.memoryGuard.stop();

    try {
      await Promise.all(context.workers.map((w) => w.close()));
      await Promise.all(context.queues.map((q) => q.close()));
      await context.redis.quit();
      await context.dataSource.destroy();

      logger.log('Shutdown complete.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown', error);
      process.exit(1);
    }
  };
}
