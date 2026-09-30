import { ConnectionOptions } from 'bullmq';
import { Env } from '../config/env';

export function createQueueConnection(env: Env): ConnectionOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  };
}
