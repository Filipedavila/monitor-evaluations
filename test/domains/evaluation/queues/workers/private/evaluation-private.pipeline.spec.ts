jest.mock('@evaluation/mapper/mapper', () => ({
  toEvaluationDTO: jest.fn((evaluation: { id: number }) => ({ id: evaluation.id, mapped: true })),
}));

import { toEvaluationDTO } from '@evaluation/mapper/mapper';
import type { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';
import { Evaluation } from '@domains/evaluation/domain/entities/evaluation.entity';
import { createPrivatePipeline } from '@evaluation/queues/workers/private/evaluation-private.pipeline';
import PRIVATE_CONFIG from '@evaluation/queues/workers/private/evaluation.private.config';
import { createSharedSteps } from '@evaluation/queues/workers/shared/shared-steps';
import { RollbackJournal } from '@evaluation/queues/workers/shared/rollback/rollback-journal';
import {
  createDepsHarness,
  createJobHarness,
  createLoggerHarness,
  EVALUATED_AT,
  firstCallOrder,
  INGESTION_METRICS,
  primeHappyPath,
  STORAGE_DATE,
  type JobOptions,
} from 'test/helpers/worker-test-utils';

function setup(jobOptions: JobOptions = {}) {
  const d = createDepsHarness();
  const fixtures = primeHappyPath(d);
  const h = createJobHarness<EvaluationDTO>(jobOptions);
  const l = createLoggerHarness();
  const pipeline = createPrivatePipeline(d.deps);
  const run = () =>
    pipeline(h.job, {
      config: PRIVATE_CONFIG,
      logger: l.logger,
      journal: new RollbackJournal(h.job),
      steps: createSharedSteps(d.deps, PRIVATE_CONFIG),
    });
  return { d, h, fixtures, run };
}

describe('createPrivatePipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path (new evaluation)', () => {
    it('evaluates the url and parses the result', async () => {
      const { d, fixtures, run } = setup();

      await run();

      expect(d.engineEvaluate).toHaveBeenCalledWith('https://example.com/page');
      expect(d.parseEvaluation).toHaveBeenCalledWith(fixtures.rawResult);
    });

    it('creates the evaluation for the user with the private context', async () => {
      const { d, run } = setup();

      await run();

      const [evaluation, contextId] = d.repoUpsert.mock.calls[0] as [Evaluation, number];
      expect(evaluation).toBeInstanceOf(Evaluation);
      expect(evaluation.pageId).toBe(10);
      expect(evaluation.evaluationDate).toEqual(new Date(EVALUATED_AT));
      expect(evaluation.createdById).toBe(99);
      expect(evaluation.id).toBeUndefined();
      expect(contextId).toBe(PRIVATE_CONFIG.contextId);
    });

    it('does not set createdById when the job has no user', async () => {
      const { d, run } = setup({ data: { userId: undefined } });

      await run();

      const [evaluation] = d.repoUpsert.mock.calls[0] as [Evaluation];
      expect(evaluation.createdById).toBeUndefined();
    });

    it('journals the created evaluation', async () => {
      const { h, run } = setup();

      await run();

      expect(h.data.evaluationId).toBe(7);
      expect(h.data.__rollback?.createdEvaluationId).toBe(7);
    });

    it('builds the ingestion metrics with the exact argument order', async () => {
      const { d, fixtures, run } = setup();

      await run();

      expect(d.parseIngestionMetrics).toHaveBeenCalledWith(
        7,
        [1, 2],
        3,
        5,
        10,
        fixtures.parsed.evaluationReport.scoring.score,
        EVALUATED_AT,
        fixtures.parsed.evaluationReport.scoring.rulesOccurrences,
      );
    });

    it('stores the artifacts and journals the storage write', async () => {
      const { d, h, run } = setup();

      await run();

      expect(d.storeSave).toHaveBeenCalledWith(
        expect.objectContaining({
          evalIdentifier: {
            evaluationId: 7,
            websiteId: 5,
            pageId: 10,
            evaluationDate: STORAGE_DATE,
          },
        }),
      );
      expect(h.data.__rollback?.storageWrites).toEqual([
        { evaluationId: 7, evaluationDate: STORAGE_DATE },
      ]);
    });

    it('completes the evaluation in the private (AMS) table', async () => {
      const { d, fixtures, run } = setup();

      await run();

      expect(d.repoComplete).toHaveBeenCalledWith(
        7,
        fixtures.parsed.evaluationData,
        'page_contexts_ams',
        10,
      );
    });

    it('publishes the metrics after completing the evaluation', async () => {
      const { d, run } = setup();

      await run();

      expect(d.publishMetrics).toHaveBeenCalledWith({
        evaluationId: 7,
        metrics: INGESTION_METRICS,
      });
      expect(firstCallOrder(d.repoComplete)).toBeLessThan(firstCallOrder(d.publishMetrics));
    });

    it('emits evaluation.completed last and returns the mapped DTO', async () => {
      const { d, fixtures, run } = setup();

      const result = await run();

      expect(d.emit).toHaveBeenCalledWith(
        'evaluation.completed',
        expect.objectContaining({ evaluationId: 7, institutionId: 3 }),
      );
      expect(firstCallOrder(d.publishMetrics)).toBeLessThan(firstCallOrder(d.emit));
      expect(toEvaluationDTO).toHaveBeenCalledWith(fixtures.completed);
      expect(result).toEqual({ id: 7, mapped: true });
    });

    it('reports progress 30, 60, 80 and 100', async () => {
      const { h, run } = setup();

      await run();

      expect(h.updateProgress.mock.calls.map(([value]) => value)).toEqual([30, 60, 80, 100]);
    });

    it('journals every write before it happens', async () => {
      const { d, h, run } = setup();

      await run();

      expect(Math.max(...h.updateData.mock.invocationCallOrder)).toBeLessThan(
        firstCallOrder(d.storeSave),
      );
    });
  });

  describe('retry (evaluation id already present)', () => {
    it('upserts the same record instead of creating a new one', async () => {
      const { d, run } = setup({
        data: { evaluationId: 7, __rollback: { createdEvaluationId: 7 } },
      });

      await run();

      const [evaluation] = d.repoUpsert.mock.calls[0] as [Evaluation];
      expect(evaluation.id).toBe(7);
    });

    it('does not journal the id again', async () => {
      const { h, run } = setup({
        data: { evaluationId: 7, __rollback: { createdEvaluationId: 7 } },
      });

      await run();

      expect(h.data.__rollback?.createdEvaluationId).toBe(7);
      expect(h.data.__rollback?.storageWrites).toHaveLength(1);
    });

    it('does not claim ownership of an id that came from the producer', async () => {
      const { h, run } = setup({ data: { evaluationId: 77 } });

      await run();

      expect(h.data.__rollback?.createdEvaluationId).toBeUndefined();
    });
  });

  describe('failures', () => {
    it.each([undefined, null])(
      'fails on an engine result of %s without any write',
      async (value) => {
        const { d, run } = setup();
        d.engineEvaluate.mockResolvedValue(value);

        await expect(run()).rejects.toThrow('Evaluation Engine returned no result');

        expect(d.repoUpsert).not.toHaveBeenCalled();
      },
    );

    it('fails without storing artifacts when ingestion metrics cannot be built, leaving the created record journaled', async () => {
      const { d, h, run } = setup();
      d.parseIngestionMetrics.mockReturnValue(undefined);

      await expect(run()).rejects.toThrow('Evaluation Parser returned no ingestion metrics');

      expect(d.storeSave).not.toHaveBeenCalled();
      expect(d.publishMetrics).not.toHaveBeenCalled();
      expect(h.data.__rollback?.createdEvaluationId).toBe(7);
    });

    it('does not complete nor publish when the storage write fails', async () => {
      const { d, h, run } = setup();
      d.storeSave.mockRejectedValue(new Error('s3 down'));

      await expect(run()).rejects.toThrow('s3 down');

      expect(d.repoComplete).not.toHaveBeenCalled();
      expect(d.publishMetrics).not.toHaveBeenCalled();
      expect(h.data.__rollback?.storageWrites).toHaveLength(1);
    });

    it('does not publish metrics when completing the evaluation fails', async () => {
      const { d, run } = setup();
      d.repoComplete.mockRejectedValue(new Error('constraint violation'));

      await expect(run()).rejects.toThrow('constraint violation');

      expect(d.publishMetrics).not.toHaveBeenCalled();
      expect(d.emit).not.toHaveBeenCalled();
    });

    it('does not emit completion when publishing the metrics fails', async () => {
      const { d, run } = setup();
      d.publishMetrics.mockRejectedValue(new Error('redis stream down'));

      await expect(run()).rejects.toThrow('redis stream down');

      expect(d.emit).not.toHaveBeenCalled();
      expect(toEvaluationDTO).not.toHaveBeenCalled();
    });
  });

  describe('Redis metrics journaling', () => {
    // Known gap: the pipeline never calls journal.recordMetricsPublished(), so a later
    // failure cannot roll back the published metrics. When fixed, change `it.failing` to `it`.
    it.failing('records in the journal that the metrics were published', async () => {
      const { h, run } = setup();

      await run();

      expect(h.data.__rollback?.isMetricsPublished).toBe(true);
    });
  });
});
