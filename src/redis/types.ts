export const REDIS_CLIENT = 'REDIS_CLIENT';

export const REDIS_STREAMS = {
  ANALYTICS_EVALUATION_BUFFER: 'analytics:evaluation:buffer',
  ANALYTICS_EVALUATION_DLQ: 'analytics:evaluation:dlq',
} as const;

export const REDIS_GROUPS = {
  ANALYTICS_EVALUATION_GROUP: 'analytics-evaluation-group',
  ANALYTICS_EVALUATION_DLQ_GROUP: 'analytics-evaluation-dlq-group',
} as const;

export type ConsumerName = `analytics-evaluation-${string}` | `analytics-evaluation-dlq-${string}`;

export type StreamName = (typeof REDIS_STREAMS)[keyof typeof REDIS_STREAMS];
export type GroupName = (typeof REDIS_GROUPS)[keyof typeof REDIS_GROUPS];
