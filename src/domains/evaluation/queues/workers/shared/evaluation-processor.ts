import { Job, UnrecoverableError } from 'bullmq';
import { createRollbackPrivateExecutor } from '../private/rollback-executor.private';
import { EvaluationPrivateWorkerDeps } from '../private/rollback-executor.private';
import { context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { createFailureHandler } from './failure-handler';
import { RollbackJournal } from './rollback/rollback-journal';
import { createRollbackExecutor } from './rollback/rollback-executor';
import { createSharedSteps } from './shared-steps';
import { createWorkerTelemetry, JobOutcome, WorkerTelemetry } from './worker-telemetry';
import {
  BaseWorkerDeps,
  EvaluationPipeline,
  FinalFailureHandler,
  WorkerConfig,
  WorkerLogger,
} from './worker.types';
import { createLogger } from '@logger/logger';
import { EvaluationJobData } from '@evaluation/types';

// Rollback for standard workers
function createStandardFinalizer(
  deps: BaseWorkerDeps,
  config: WorkerConfig,
  logger: WorkerLogger,
  telemetry: WorkerTelemetry,
): FinalFailureHandler {
  const rollback = createRollbackExecutor(deps, logger);
  const handleFinalFailure = createFailureHandler(deps, config, logger, telemetry);

  return async (job, error) => {
    await rollback(job);
    await handleFinalFailure(job, error);
  };
}

// Rollback for private worker
function createPrivateFinalizer(
  deps: EvaluationPrivateWorkerDeps,
  config: WorkerConfig,
  logger: WorkerLogger,
  telemetry: WorkerTelemetry,
): FinalFailureHandler {
  const rollback = createRollbackPrivateExecutor(deps, logger);
  const handleFinalFailure = createFailureHandler(deps, config, logger, telemetry);

  return async (job, error) => {
    await rollback(job);
    await handleFinalFailure(job, error);
  };
}

// Factory to select the correct implementation
function createFinalizer(
  deps: BaseWorkerDeps | EvaluationPrivateWorkerDeps,
  config: WorkerConfig,
  logger: WorkerLogger,
  telemetry: WorkerTelemetry,
): FinalFailureHandler {
  if (config.name === 'private') {
    return createPrivateFinalizer(deps as EvaluationPrivateWorkerDeps, config, logger, telemetry);
  }
  return createStandardFinalizer(deps, config, logger, telemetry);
}

/**
 * Common processing logic for all workers. Handles OTel context, spans, metrics and final attempt detection.
 * Intermediate attempts skip rollback since steps are idempotent. On final failure, rolls back using the journal.
 */
export function createEvaluationProcessor<TResult>(
  deps: BaseWorkerDeps,
  config: WorkerConfig,
  pipeline: EvaluationPipeline<TResult>,
) {
  const logger = createLogger(config.loggerContext);
  const telemetry = createWorkerTelemetry(config.name);
  const steps = createSharedSteps(deps, config);
  const finalize = createFinalizer(deps, config, logger, telemetry);

  return async function process(job: Job<EvaluationJobData, TResult, string>): Promise<TResult> {
    const parentContext = job.data.__otelContext
      ? propagation.extract(context.active(), job.data.__otelContext)
      : context.active();

    return telemetry.tracer.startActiveSpan(
      `evaluation-${config.name}-worker-process`,
      {
        attributes: {
          'bullmq.job.id': job.id ?? 'unknown',
          'evaluation.page_id': job.data.pageId,
          ...config.spanAttributes(job),
        },
      },
      parentContext,
      async (span): Promise<TResult> => {
        const journal = new RollbackJournal(job);
        const startedAt = performance.now();
        let outcome: JobOutcome = 'failure';

        try {
          const result = await pipeline(job, { config, logger, journal, steps });

          span.setStatus({ code: SpanStatusCode.OK });
          outcome = 'success';
          return result;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(
            `Erro no job ${job.id} (Página ${job.data.pageId}): ${err.message}`,
            err.stack,
          );

          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

          const maxAttempts = job.opts.attempts ?? 1;
          const isFinalAttempt =
            err instanceof UnrecoverableError || job.attemptsMade + 1 >= maxAttempts;

          if (isFinalAttempt) await finalize(job, err);

          throw err;
        } finally {
          telemetry.recordJob(outcome, performance.now() - startedAt);
          span.end();
        }
      },
    );
  };
}

/**
 * Recovery handler for jobs that fail due to stalls (e.g. repeated OOM) without going through the processor.
 * Uses the same rollback/DLQ logic as final failures, reading from the journal in Redis.
 */
export function createEvaluationRecovery(
  deps: BaseWorkerDeps,
  config: WorkerConfig,
): FinalFailureHandler {
  const logger = createLogger(config.loggerContext);
  const telemetry = createWorkerTelemetry(config.name);
  return createFinalizer(deps, config, logger, telemetry);
}
