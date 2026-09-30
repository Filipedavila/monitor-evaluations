import Redis from 'ioredis';
import { Env } from '../config/env';

export function createRedisClient(env: Env): Redis {
  return new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB_BUFFER,
  });
}
