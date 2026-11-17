jest.mock('@evaluation/mapper/mapper', () => ({
  toEvaluationDTO: jest.fn((evaluation: { id: number }) => ({ id: evaluation.id, mapped: true })),
}));

import { toEvaluationDTO } from '@evaluation/mapper/mapper';
import type { EvaluationDTO } from '@evaluation/application/dto/evaluation.dto';
import { Evaluation } from '@domains/evaluation/domain/entities/evaluation.entity';
import { createPublicPipeline } from '@evaluation/queues/workers/public/evaluation-public.pipeline';
import PUBLIC_CONFIG from '@evaluation/queues/workers/public/evaluation.public.config';
import { createSharedSteps } from '@evaluation/queues/workers//shared/shared-steps';
import { RollbackJournal } from '@evaluation/queues/workers//shared/rollback/rollback-journal';
import {
  createDepsHarness,
  createJobHarness,
  createLoggerHarness,
  EVALUATED_AT,
  firstCallOrder,
  primeHappyPath,
  STORAGE_DATE,
  type JobOptions,
} from 'test/helpers/worker-test-utils';

function setup(jobOptions: JobOptions = {}) {
  const d = createDepsHarness();
  const fixtures = primeHappyPath(d);
  const h = createJobHarness<EvaluationDTO>(jobOptions);
  const l = createLoggerHarness();
  const pipeline = createPublicPipeline(d.deps);
  const run = () =>
    pipeline(h.job, {
      config: PUBLIC_CONFIG,
      logger: l.logger,
      journal: new RollbackJournal(h.job),
      steps: createSharedSteps(d.deps, PUBLIC_CONFIG),
    });
  return { d, h, fixtures, run };
}

describe('createPublicPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path (new evaluation)', () => {
    it('evaluates the job url and parses the engine result', async () => {
      const { d, fixtures, run } = setup();

      await run();

      expect(d.engineEvaluate).toHaveBeenCalledWith('https://example.com/page');
      expect(d.parseEvaluation).toHaveBeenCalledWith(fixtures.rawResult);
    });

    it('creates the evaluation with the page, the evaluation date and the public context', async () => {
      const { d, run } = setup();

      await run();

      const [evaluation, contextId] = d.repoUpsert.mock.calls[0] as [Evaluation, number];
      expect(evaluation).toBeInstanceOf(Evaluation);
      expect(evaluation.pageId).toBe(10);
      expect(evaluation.evaluationDate).toEqual(new Date(EVALUATED_AT));
      expect(evaluation.id).toBeUndefined();
      expect(contextId).toBe(PUBLIC_CONFIG.contextId);
    });

    it('journals the created evaluation and exposes its id on the job', async () => {
      const { h, run } = setup();

      await run();

      expect(h.data.evaluationId).toBe(7);
      expect(h.data.__rollback?.createdEvaluationId).toBe(7);
    });

    it('saves the artifacts and journals the storage write', async () => {
      const { d, h, fixtures, run } = setup();

      await run();

      expect(d.storeSave).toHaveBeenCalledWith({
        htmlContent: fixtures.parsed.evaluationReport.snapshot.html,
        nodes: fixtures.parsed.evaluationReport.scoring.assertionEvidence,
        conformance: fixtures.parsed.evaluationReport.scoring.conform,
        evalIdentifier: { evaluationId: 7, websiteId: 5, pageId: 10, evaluationDate: STORAGE_DATE },
      });
      expect(h.data.__rollback?.storageWrites).toEqual([
        { evaluationId: 7, evaluationDate: STORAGE_DATE },
      ]);
    });

    it('completes the evaluation in the monitor table', async () => {
      const { d, fixtures, run } = setup();

      await run();

      expect(d.repoComplete).toHaveBeenCalledWith(
        7,
        fixtures.parsed.evaluationData,
        'page_contexts_monitor',
        10,
      );
    });

    it('emits evaluation.completed with the evaluation id and returns the mapped DTO', async () => {
      const { d, fixtures, run } = setup();

      const result = await run();

      expect(d.emit).toHaveBeenCalledWith(
        'evaluation.completed',
        expect.objectContaining({ pageId: 10, websiteId: 5, evaluationId: 7 }),
      );
      expect(toEvaluationDTO).toHaveBeenCalledWith(fixtures.completed);
      expect(result).toEqual({ id: 7, mapped: true });
    });

    it('reports progress 50, 70 and 100', async () => {
      const { h, run } = setup();

      await run();

      expect(h.updateProgress.mock.calls.map(([value]) => value)).toEqual([50, 70, 100]);
    });

    it('runs the steps in order and journals before touching storage', async () => {
      const { d, h, run } = setup();

      await run();

      expect(firstCallOrder(d.engineEvaluate)).toBeLessThan(firstCallOrder(d.parseEvaluation));
      expect(firstCallOrder(d.parseEvaluation)).toBeLessThan(firstCallOrder(d.repoUpsert));
      expect(firstCallOrder(d.repoUpsert)).toBeLessThan(firstCallOrder(d.storeSave));
      expect(Math.max(...h.updateData.mock.invocationCallOrder)).toBeLessThan(
        firstCallOrder(d.storeSave),
      );
      expect(firstCallOrder(d.storeSave)).toBeLessThan(firstCallOrder(d.repoComplete));
      expect(firstCallOrder(d.repoComplete)).toBeLessThan(firstCallOrder(d.emit));
    });
  });

  describe('retry (evaluation id already present)', () => {
    it('reuses the id of a previous attempt without creating another evaluation', async () => {
      const { d, run } = setup({
        data: { evaluationId: 7, __rollback: { createdEvaluationId: 7 } },
      });

      await run();

      expect(d.repoUpsert).not.toHaveBeenCalled();
      expect(d.storeSave).toHaveBeenCalledWith(
        expect.objectContaining({ evalIdentifier: expect.objectContaining({ evaluationId: 7 }) }),
      );
      expect(d.repoComplete).toHaveBeenCalledWith(7, expect.anything(), expect.anything(), 10);
    });

    it('does not claim ownership of an id that came from the producer', async () => {
      const { d, h, run } = setup({ data: { evaluationId: 77 } });

      await run();

      expect(d.repoUpsert).not.toHaveBeenCalled();
      expect(h.data.__rollback?.createdEvaluationId).toBeUndefined();
    });
  });

  describe('failures', () => {
    it.each([undefined, null])(
      'fails when the engine returns %s, before parsing or writing anything',
      async (value) => {
        const { d, run } = setup();
        d.engineEvaluate.mockResolvedValue(value);

        await expect(run()).rejects.toThrow('Evaluation Engine returned no result');

        expect(d.parseEvaluation).not.toHaveBeenCalled();
        expect(d.repoUpsert).not.toHaveBeenCalled();
        expect(d.storeSave).not.toHaveBeenCalled();
      },
    );

    it('propagates engine errors without side effects', async () => {
      const { d, h, run } = setup();
      d.engineEvaluate.mockRejectedValue(new Error('timeout'));

      await expect(run()).rejects.toThrow('timeout');

      expect(d.repoUpsert).not.toHaveBeenCalled();
      expect(h.data.__rollback).toBeUndefined();
    });

    it('does not touch the database when parsing fails', async () => {
      const { d, run } = setup();
      d.parseEvaluation.mockImplementation(() => {
        throw new Error('invalid report');
      });

      await expect(run()).rejects.toThrow('invalid report');

      expect(d.repoUpsert).not.toHaveBeenCalled();
    });

    it('does not write storage nor journal anything when creating the evaluation fails', async () => {
      const { d, h, run } = setup();
      d.repoUpsert.mockRejectedValue(new Error('db down'));

      await expect(run()).rejects.toThrow('db down');

      expect(d.storeSave).not.toHaveBeenCalled();
      expect(h.data.__rollback).toBeUndefined();
    });

    it('does not write storage when the created id cannot be journaled', async () => {
      const { d, h, run } = setup();
      h.updateData.mockRejectedValue(new Error('redis down'));

      await expect(run()).rejects.toThrow('redis down');

      expect(d.storeSave).not.toHaveBeenCalled();
    });

    it('leaves the created evaluation and the storage write journaled when the storage fails', async () => {
      const { d, h, run } = setup();
      d.storeSave.mockRejectedValue(new Error('s3 down'));

      await expect(run()).rejects.toThrow('s3 down');

      expect(d.repoComplete).not.toHaveBeenCalled();
      expect(h.data.__rollback).toEqual({
        createdEvaluationId: 7,
        storageWrites: [{ evaluationId: 7, evaluationDate: STORAGE_DATE }],
      });
    });

    it('does not emit nor map the DTO when completing the evaluation fails', async () => {
      const { d, run } = setup();
      d.repoComplete.mockRejectedValue(new Error('constraint violation'));

      await expect(run()).rejects.toThrow('constraint violation');

      expect(d.emit).not.toHaveBeenCalled();
      expect(toEvaluationDTO).not.toHaveBeenCalled();
    });
  });
});
