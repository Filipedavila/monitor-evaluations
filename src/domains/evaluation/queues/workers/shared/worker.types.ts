import { Job, Queue } from 'bullmq';
import { Attributes } from '@opentelemetry/api';
import { DataSource } from 'typeorm';

import type { RollbackJournal } from './rollback/rollback-journal';
import type { SharedSteps } from './shared-steps';
import { EvaluationJobData } from '@evaluation/types';
import { createLogger } from '@logger/logger';
import { EvaluationEngine } from '@evaluation/contracts/evaluation-engine.contract';
import { EvaluationParserService } from '@evaluation/application/evaluation-parser.service';
import { EvaluationRepository } from '@evaluation/infrastructure/persistence/evaluation.repository';
import { EvaluationEventBus } from '@events/evaluation-events';
import { EvaluationStorage } from '@evaluation/contracts/evaluation-storage.contract';

export type WorkerLogger = ReturnType<typeof createLogger>;
export type EvaluationId = NonNullable<EvaluationJobData['evaluationId']>;
export type WorkerName = 'public' | 'private';
export type PageTable = 'page_contexts_monitor' | 'page_contexts_ams';

export interface BaseWorkerDeps {
  dlqQueue: Queue;
  evaluationEngine: EvaluationEngine;
  evaluationStore: EvaluationStorage;
  evaluationParser: EvaluationParserService;
  evaluationRepository: EvaluationRepository;
  eventBus: EvaluationEventBus;
  dataSource: DataSource;
}

export interface WorkerConfig {
  name: WorkerName;
  loggerContext: string;
  contextId: number;
  pageTable: PageTable;
  spanAttributes: (job: Job<EvaluationJobData>) => Attributes;
  buildDlqPayload: (job: Job<EvaluationJobData>, error: Error) => Record<string, unknown>;
}

export interface PipelineContext {
  config: WorkerConfig;
  logger: WorkerLogger;
  journal: RollbackJournal;
  steps: SharedSteps;
}

export type EvaluationPipeline<TResult> = (
  job: Job<EvaluationJobData, TResult, string>,
  ctx: PipelineContext,
) => Promise<TResult>;

export type FinalFailureHandler = (job: Job<EvaluationJobData>, error: Error) => Promise<void>;
