import { WorkerConfig } from '../shared/worker.types';
import { Job } from 'bullmq';
import { EvaluationJobData } from '@evaluation/types';

const PRIVATE_CONFIG: WorkerConfig = {
  name: 'private',
  loggerContext: 'EvaluationPrivateWorker',
  contextId: 1,
  pageTable: 'page_contexts_ams',
  spanAttributes: (job: Job<EvaluationJobData>) => ({
    'evaluation.institution_id': job.data.institutionId,
  }),
  buildDlqPayload: (job, error) => ({
    originalJobId: job.id,
    data: job.data,
    error: { message: error.message, stack: error.stack },
    failedAt: new Date().toISOString(),
  }),
};

export default PRIVATE_CONFIG;
