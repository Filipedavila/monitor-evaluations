import { EvaluationJobData } from '@/domains/evaluation/types';
import type { Job } from 'bullmq';
import { WorkerConfig } from '../shared/worker.types';

const PUBLIC_CONFIG: WorkerConfig = {
  name: 'public',
  loggerContext: 'EvaluationPublicWorker',
  contextId: 2,
  pageTable: 'page_contexts_monitor',
  spanAttributes: (job: Job<EvaluationJobData>) => ({
    'evaluation.website_id': job.data.websiteId,
  }),
  buildDlqPayload: (job, error) => ({
    originalJobId: job.id,
    data: job.data,
    failedReason: error.message,
    stacktrace: error.stack,
    failedAt: new Date().toISOString(),
  }),
};

export default PUBLIC_CONFIG;
