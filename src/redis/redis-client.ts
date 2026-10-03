import Redis from 'ioredis';
import { Env } from '../config/env';

export function createRedisClient(env: Env): Redis {
  return new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    db: 1,
  });
}
