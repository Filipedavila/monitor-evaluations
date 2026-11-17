import { Worker } from 'bullmq';
import {
  createEvaluationProcessor,
  createEvaluationRecovery,
} from '../shared/evaluation-processor';
import { attachEvaluationWorkerEvents } from '../shared/events/worker-events';
import { BaseWorkerDeps, FinalFailureHandler } from '../shared/worker.types';
import PUBLIC_CONFIG from './evaluation.public.config';
import { EvaluationJobData } from '@evaluation/types';
import { EvaluationEventBus } from '@events/evaluation-events';
import { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';
import { createPublicPipeline } from './evaluation-public.pipeline';

export type EvaluationPublicWorkerDeps = BaseWorkerDeps;

export function createEvaluationPublicProcessor(deps: EvaluationPublicWorkerDeps) {
  return createEvaluationProcessor(deps, PUBLIC_CONFIG, createPublicPipeline(deps));
}

export function createEvaluationPublicRecovery(
  deps: EvaluationPublicWorkerDeps,
): FinalFailureHandler {
  return createEvaluationRecovery(deps, PUBLIC_CONFIG);
}

export function attachEvaluationPublicWorkerEvents(
  worker: Worker<EvaluationJobData, EvaluationDTO, string>,
  eventBus: EvaluationEventBus,
  recoverStalledJob?: FinalFailureHandler,
): void {
  attachEvaluationWorkerEvents(worker, eventBus, PUBLIC_CONFIG.loggerContext, {
    describeResult: (result) => `Evaluation ${result?.id}`,
    recoverStalledJob,
  });
}
