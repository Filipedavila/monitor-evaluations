import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ path: `.env.${process.env.NODE_ENV === 'production' ? 'prod' : 'dev'}`, override: true });

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB_BUFFER: z.coerce.number().default(1),

  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().default(3306),
  DB_USERNAME: z.string(),
  DB_PASSWORD: z.string(),
  DB_DATABASE: z.string(),

  MEMORY_HEAP_LIMIT_MB: z.coerce.number().default(350),
  MEMORY_GUARD_CHECK_INTERVAL_MS: z.coerce.number().default(15000),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
