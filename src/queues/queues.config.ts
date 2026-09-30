export const QUEUE_NAMES = {
  EVAL_PUBLIC: 'evaluation-queue-public',
  EVAL_PUBLIC_DLQ: 'evaluation-queue-public-dlq',
  EVAL_PRIVATE: 'evaluation-queue-private',
  EVAL_PRIVATE_DLQ: 'evaluation-queue-private-dlq',
};

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5000,
  },
  removeOnComplete: true,
  removeOnFail: false,
};
