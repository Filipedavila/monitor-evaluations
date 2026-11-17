import type { Job } from 'bullmq';
import type { EvaluationJobData } from '@evaluation/types';
import type {
  WorkerConfig,
  WorkerLogger,
} from '@domains/evaluation/queues/workers/shared/worker.types';
import type { WorkerTelemetry } from '@domains/evaluation/queues/workers/shared/worker-telemetry';
import type { EvaluationPrivateWorkerDeps } from '@domains/evaluation/queues/workers/private/rollback-executor.private';

export const RAW_RESULT = { raw: 'engine-result' };
export const INGESTION_METRICS = { metrics: 'ingestion' };
export const EVALUATED_AT = '2024-05-10T10:20:30.000Z';
export const STORAGE_DATE = '2024-05-10';

export const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function firstCallOrder(mock: jest.Mock): number {
  return mock.mock.invocationCallOrder[0];
}

export function buildJobData(overrides: Partial<EvaluationJobData> = {}): EvaluationJobData {
  const base = {
    pageId: 10,
    websiteId: 5,
    url: 'https://example.com/page',
    institutionId: 3,
    directoryIds: [1, 2],
    userId: 99,
  };
  return { ...base, ...overrides } as unknown as EvaluationJobData;
}

export function journalState(state: Record<string, unknown>): EvaluationJobData['__rollback'] {
  return state as unknown as EvaluationJobData['__rollback'];
}

interface RawJob {
  id: string | undefined;
  data: EvaluationJobData;
  opts: { attempts?: number };
  attemptsMade: number;
  updateData: jest.Mock<Promise<void>, [EvaluationJobData]>;
  updateProgress: jest.Mock<Promise<void>, [number]>;
  log: jest.Mock<Promise<number>, [string]>;
}

export interface JobOptions {
  id?: string | null;
  data?: Partial<EvaluationJobData>;
  attempts?: number;
  attemptsMade?: number;
}

export interface JobHarness<TResult = unknown> {
  job: Job<EvaluationJobData, TResult, string>;
  readonly data: EvaluationJobData;
  updateData: jest.Mock<Promise<void>, [EvaluationJobData]>;
  updateProgress: jest.Mock<Promise<void>, [number]>;
  log: jest.Mock<Promise<number>, [string]>;
  setAttemptsMade(attemptsMade: number): void;
}

export function createJobHarness<TResult = unknown>(options: JobOptions = {}): JobHarness<TResult> {
  const raw: RawJob = {
    id: options.id === null ? undefined : (options.id ?? 'job-1'),
    data: buildJobData(options.data),
    opts: options.attempts === undefined ? {} : { attempts: options.attempts },
    attemptsMade: options.attemptsMade ?? 0,
    updateData: jest.fn<Promise<void>, [EvaluationJobData]>(async (next) => {
      raw.data = next;
    }),
    updateProgress: jest.fn<Promise<void>, [number]>(async () => undefined),
    log: jest.fn<Promise<number>, [string]>(async () => 1),
  };

  return {
    job: raw as unknown as Job<EvaluationJobData, TResult, string>,
    get data(): EvaluationJobData {
      return raw.data;
    },
    updateData: raw.updateData,
    updateProgress: raw.updateProgress,
    log: raw.log,
    setAttemptsMade(attemptsMade: number): void {
      raw.attemptsMade = attemptsMade;
    },
  };
}

export interface DepsHarness {
  deps: EvaluationPrivateWorkerDeps;
  dlqAdd: jest.Mock;
  engineEvaluate: jest.Mock;
  storeSave: jest.Mock;
  storeDelete: jest.Mock;
  parseEvaluation: jest.Mock;
  parseIngestionMetrics: jest.Mock;
  repoUpsert: jest.Mock;
  repoComplete: jest.Mock;
  repoDelete: jest.Mock;
  emit: jest.Mock;
  query: jest.Mock;
  metricsRollbackAdd: jest.Mock;
  publishMetrics: jest.Mock;
}

export function createDepsHarness(): DepsHarness {
  const dlqAdd = jest.fn().mockResolvedValue({ id: 'dlq-1' });
  const engineEvaluate = jest.fn();
  const storeSave = jest.fn().mockResolvedValue(undefined);
  const storeDelete = jest.fn().mockResolvedValue(undefined);
  const parseEvaluation = jest.fn();
  const parseIngestionMetrics = jest.fn();
  const repoUpsert = jest.fn();
  const repoComplete = jest.fn();
  const repoDelete = jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn();
  const query = jest.fn().mockResolvedValue([]);
  const metricsRollbackAdd = jest.fn().mockResolvedValue({ id: 'rollback-1' });
  const publishMetrics = jest.fn().mockResolvedValue(undefined);

  const deps = {
    dlqQueue: { add: dlqAdd },
    evaluationEngine: { evaluate: engineEvaluate },
    evaluationStore: { save: storeSave, delete: storeDelete },
    evaluationParser: { parseEvaluation, parseIngestionMetrics },
    evaluationRepository: {
      upsertEvaluation: repoUpsert,
      completeEvaluation: repoComplete,
      delete: repoDelete,
    },
    eventBus: { emit },
    dataSource: { query },
    metricsRollbackQueue: { add: metricsRollbackAdd },
    evaluationPersister: { publishMetrics },
  } as unknown as EvaluationPrivateWorkerDeps;

  return {
    deps,
    dlqAdd,
    engineEvaluate,
    storeSave,
    storeDelete,
    parseEvaluation,
    parseIngestionMetrics,
    repoUpsert,
    repoComplete,
    repoDelete,
    emit,
    query,
    metricsRollbackAdd,
    publishMetrics,
  };
}

export function buildParsedEvaluation(evaluatedAt: string = EVALUATED_AT) {
  return {
    evaluationReport: {
      metadata: { evaluatedAt },
      snapshot: { html: '<html><body>page</body></html>' },
      scoring: {
        score: 87.5,
        conform: { A: 1, AA: 2, AAA: 3 },
        assertionEvidence: { 'rule-1': ['evidence'] },
        rulesOccurrences: { 'rule-1': 2 },
      },
    },
    evaluationData: { score: '87.5', pageTitle: 'Example' },
  };
}

export type ParsedEvaluationFixture = ReturnType<typeof buildParsedEvaluation>;

export interface PrimedFixtures {
  rawResult: typeof RAW_RESULT;
  parsed: ParsedEvaluationFixture;
  created: { id: number };
  completed: { id: number; score: string };
  ingestionMetrics: typeof INGESTION_METRICS;
}

export function primeHappyPath(
  harness: DepsHarness,
  options: { evaluationId?: number; evaluatedAt?: string } = {},
): PrimedFixtures {
  const evaluationId = options.evaluationId ?? 7;
  const parsed = buildParsedEvaluation(options.evaluatedAt);
  const created = { id: evaluationId };
  const completed = { id: evaluationId, score: '87.5' };

  harness.engineEvaluate.mockResolvedValue(RAW_RESULT);
  harness.parseEvaluation.mockReturnValue(parsed);
  harness.parseIngestionMetrics.mockReturnValue(INGESTION_METRICS);
  harness.repoUpsert.mockResolvedValue(created);
  harness.repoComplete.mockResolvedValue(completed);

  return { rawResult: RAW_RESULT, parsed, created, completed, ingestionMetrics: INGESTION_METRICS };
}

export interface LoggerHarness {
  logger: WorkerLogger;
  log: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
}

export function createLoggerHarness(): LoggerHarness {
  const log = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  const debug = jest.fn();
  return {
    logger: { log, warn, error, debug, verbose: jest.fn() } as unknown as WorkerLogger,
    log,
    warn,
    error,
    debug,
  };
}

export interface TelemetryHarness {
  telemetry: WorkerTelemetry;
  recordJob: jest.Mock;
  recordFinalFailure: jest.Mock;
  recordDeadLettered: jest.Mock;
}

export function createTelemetryHarness(): TelemetryHarness {
  const recordJob = jest.fn();
  const recordFinalFailure = jest.fn();
  const recordDeadLettered = jest.fn();
  return {
    telemetry: {
      tracer: {},
      recordJob,
      recordFinalFailure,
      recordDeadLettered,
    } as unknown as WorkerTelemetry,
    recordJob,
    recordFinalFailure,
    recordDeadLettered,
  };
}

export function buildConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'public',
    loggerContext: 'TestWorker',
    contextId: 2,
    pageTable: 'page_contexts_monitor',
    spanAttributes: jest.fn(() => ({})),
    buildDlqPayload: jest.fn((job: Job<EvaluationJobData>, error: Error) => ({
      originalJobId: job.id,
      failedReason: error.message,
    })),
    ...overrides,
  };
}
