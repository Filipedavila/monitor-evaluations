import { Queue, Worker } from 'bullmq';
import { AppContainer } from './container';
import { QUEUE_NAMES } from '@infrastructure/queues/queues.config';
import {
  createEvaluationPrivateProcessor,
  attachEvaluationPrivateWorkerEvents,
} from '@evaluation/queues/workers/private/evaluation-private.worker';
import {
  createEvaluationPublicProcessor,
  attachEvaluationPublicWorkerEvents,
} from '@evaluation/queues/workers/public/evaluation-public.worker';

export interface WorkerInfrastructure {
  workers: Worker[];
  queues: Queue[];
}

export function setupWorkers(container: AppContainer): WorkerInfrastructure {
  const { connection, eventBus, ...deps } = container;

  const privateDlqQueue = new Queue(QUEUE_NAMES.EVAL_PRIVATE_DLQ, { connection });
  const publicDlqQueue = new Queue(QUEUE_NAMES.EVAL_PUBLIC_DLQ, { connection });
  const metricsRollbackQueue = new Queue(QUEUE_NAMES.EVAL_PRIVATE_ROLLBACK, { connection });

  const privateProcessor = createEvaluationPrivateProcessor({
    metricsRollbackQueue: metricsRollbackQueue,
    dlqQueue: privateDlqQueue,
    ...deps,
    eventBus,
  });

  const publicProcessor = createEvaluationPublicProcessor({
    dlqQueue: publicDlqQueue,
    ...deps,
    eventBus,
  });

  const privateWorker = new Worker(QUEUE_NAMES.EVAL_PRIVATE, privateProcessor, {
    connection,
    concurrency: 2,
    lockDuration: 180000,
  });
  attachEvaluationPrivateWorkerEvents(privateWorker, eventBus);

  const publicWorker = new Worker(QUEUE_NAMES.EVAL_PUBLIC, publicProcessor, {
    connection,
    concurrency: 2,
    lockDuration: 180000,
  });
  attachEvaluationPublicWorkerEvents(publicWorker, eventBus);

  return {
    workers: [privateWorker, publicWorker],
    queues: [privateDlqQueue, publicDlqQueue, metricsRollbackQueue],
  };
}
