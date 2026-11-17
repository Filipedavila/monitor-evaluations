import { Job, Worker, Queue } from 'bullmq';
import PRIVATE_CONFIG from './evaluation.private.config';
import { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';
import { EvaluationPrivateWorkerDeps } from './rollback-executor.private';

import {
  createEvaluationProcessor,
  createEvaluationRecovery,
} from '../shared/evaluation-processor';
import { attachEvaluationWorkerEvents } from '../shared/events/worker-events';
import { FinalFailureHandler } from '../shared/worker.types';
import { createPrivatePipeline } from './evaluation-private.pipeline';
import { EvaluationJobData } from '@evaluation/types';
import { EvaluationEventBus } from '@events/evaluation-events';

export function createEvaluationPrivateProcessor(deps: EvaluationPrivateWorkerDeps) {
  return createEvaluationProcessor<EvaluationDTO>(
    deps,
    PRIVATE_CONFIG,
    createPrivatePipeline(deps),
  );
}

/** Rollback + DLQ para jobs falhados por stall (ex.: OOM repetido). Passar a `attach...Events`. */
export function createEvaluationPrivateRecovery(
  deps: EvaluationPrivateWorkerDeps,
): FinalFailureHandler {
  return createEvaluationRecovery(deps, PRIVATE_CONFIG);
}

export function attachEvaluationPrivateWorkerEvents(
  worker: Worker<EvaluationJobData, EvaluationDTO, string>,
  eventBus: EvaluationEventBus,
  recoverStalledJob?: FinalFailureHandler,
): void {
  attachEvaluationWorkerEvents(worker, eventBus, PRIVATE_CONFIG.loggerContext, {
    recoverStalledJob,
  });
}
