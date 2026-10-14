import { ConnectionOptions } from 'bullmq';
import { Env } from '../config/env';
import { BullMQOtel } from 'bullmq-otel';

export function createQueueConnection(env: Env): ConnectionOptions {
  const telemetry = new BullMQOtel({
    tracerName: process.env.OTEL_SERVICE_NAME || 'monitor-server',
    meterName: process.env.OTEL_SERVICE_NAME || 'monitor-server',
    enableMetrics: true,
  });
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    db: env.REDIS_DB_BULL,
    telemetry,
  };
}
