import { metrics, trace } from '@opentelemetry/api';

export type JobOutcome = 'success' | 'failure';

/**
 * Tracer + métricas de um worker. O prefixo do nome distingue workers
 * (evaluation.public.*, evaluation.private.*) sem duplicar código.
 *
 * Atributos com baixa cardinalidade: nunca usar pageId, websiteId ou jobId nas métricas.
 */
export function createWorkerTelemetry(workerName: string) {
  const tracer = trace.getTracer(`evaluation-${workerName}-worker`);
  const meter = metrics.getMeter(`evaluation-${workerName}-worker`);
  const prefix = `evaluation.${workerName}`;

  const jobsProcessed = meter.createCounter(`${prefix}.jobs.processed`, {
    description: 'Jobs processados, por resultado (success/failure)',
    unit: '{job}',
  });
  const jobsFailedFinal = meter.createCounter(`${prefix}.jobs.failed_final`, {
    description: 'Jobs que falharam na última tentativa',
    unit: '{job}',
  });
  const jobsDeadLettered = meter.createCounter(`${prefix}.jobs.dead_lettered`, {
    description: 'Jobs enviados com sucesso para a DLQ',
    unit: '{job}',
  });
  const jobDuration = meter.createHistogram(`${prefix}.job.duration`, {
    description: 'Duração do processamento de um job',
    unit: 'ms',
  });

  return {
    tracer,
    recordJob(outcome: JobOutcome, durationMs: number): void {
      jobsProcessed.add(1, { outcome });
      jobDuration.record(durationMs, { outcome });
    },
    recordFinalFailure(): void {
      jobsFailedFinal.add(1);
    },
    recordDeadLettered(): void {
      jobsDeadLettered.add(1);
    },
  };
}

export type WorkerTelemetry = ReturnType<typeof createWorkerTelemetry>;
