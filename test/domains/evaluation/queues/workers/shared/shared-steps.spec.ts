import {
  createSharedSteps,
  type SharedSteps,
} from '@evaluation/queues/workers/shared/shared-steps';
import { RollbackJournal } from '@evaluation/queues/workers/shared/rollback/rollback-journal';
import { PageStatus } from '@evaluation/domain/evaluation.constants';
import {
  buildConfig,
  buildParsedEvaluation,
  createDepsHarness,
  createJobHarness,
  EVALUATED_AT,
  firstCallOrder,
  STORAGE_DATE,
} from 'test/helpers/worker-test-utils';

type Report = Parameters<SharedSteps['saveToStorage']>[3];

function setup(pageTable: 'page_contexts_monitor' | 'page_contexts_ams' = 'page_contexts_monitor') {
  const d = createDepsHarness();
  const h = createJobHarness();
  const steps = createSharedSteps(d.deps, buildConfig({ pageTable }));
  const journal = new RollbackJournal(h.job);
  const parsed = buildParsedEvaluation();
  const report = parsed.evaluationReport as unknown as Report;
  return { d, h, steps, journal, parsed, report };
}

describe('createSharedSteps', () => {
  describe('evaluateOrThrow', () => {
    it('evaluates the url with the engine and returns the result', async () => {
      const { d, steps } = setup();
      d.engineEvaluate.mockResolvedValue({ raw: 'result' });

      await expect(steps.evaluateOrThrow('https://example.com')).resolves.toEqual({
        raw: 'result',
      });

      expect(d.engineEvaluate).toHaveBeenCalledWith('https://example.com');
    });

    it.each([undefined, null])('throws when the engine returns %s', async (value) => {
      const { d, steps } = setup();
      d.engineEvaluate.mockResolvedValue(value);

      await expect(steps.evaluateOrThrow('https://example.com')).rejects.toThrow(
        'Evaluation Engine returned no result',
      );
    });

    it('propagates engine errors untouched', async () => {
      const { d, steps } = setup();
      const error = new Error('browser crashed');
      d.engineEvaluate.mockRejectedValue(error);

      await expect(steps.evaluateOrThrow('https://example.com')).rejects.toBe(error);
    });
  });

  describe('saveToStorage', () => {
    it('saves html, evidences, conformance and identifiers', async () => {
      const { d, h, steps, journal, parsed, report } = setup();

      await steps.saveToStorage(h.job, 7, EVALUATED_AT, report, journal);

      expect(d.storeSave).toHaveBeenCalledWith({
        htmlContent: parsed.evaluationReport.snapshot.html,
        nodes: parsed.evaluationReport.scoring.assertionEvidence,
        conformance: parsed.evaluationReport.scoring.conform,
        evalIdentifier: {
          evaluationId: 7,
          websiteId: 5,
          pageId: 10,
          evaluationDate: STORAGE_DATE,
        },
      });
    });

    it.each<[string | Date, string]>([
      ['2024-05-10T10:20:30.000Z', '2024-05-10'],
      ['2024-05-10T23:59:59.999Z', '2024-05-10'],
      ['2024-05-10T00:00:00.000+02:00', '2024-05-09'],
      [new Date('2024-12-31T23:30:00.000Z'), '2024-12-31'],
    ])('normalises %s to the UTC day %s', async (input, expected) => {
      const { d, h, steps, journal, report } = setup();

      await steps.saveToStorage(h.job, 7, input, report, journal);

      expect(d.storeSave.mock.calls[0][0].evalIdentifier.evaluationDate).toBe(expected);
      expect(h.data.__rollback?.storageWrites).toEqual([
        { evaluationId: 7, evaluationDate: expected },
      ]);
    });

    it('journals the write before writing to storage', async () => {
      const { d, h, steps, journal, report } = setup();

      await steps.saveToStorage(h.job, 7, EVALUATED_AT, report, journal);

      expect(Math.max(...h.updateData.mock.invocationCallOrder)).toBeLessThan(
        firstCallOrder(d.storeSave),
      );
    });

    it('does not write to storage when the journal cannot be persisted', async () => {
      const { d, h, steps, journal, report } = setup();
      h.updateData.mockRejectedValue(new Error('redis down'));

      await expect(steps.saveToStorage(h.job, 7, EVALUATED_AT, report, journal)).rejects.toThrow(
        'redis down',
      );

      expect(d.storeSave).not.toHaveBeenCalled();
    });

    it('keeps the journal entry when the storage write fails, so rollback can clean up', async () => {
      const { d, h, steps, journal, report } = setup();
      d.storeSave.mockRejectedValue(new Error('s3 down'));

      await expect(steps.saveToStorage(h.job, 7, EVALUATED_AT, report, journal)).rejects.toThrow(
        's3 down',
      );

      expect(h.data.__rollback?.storageWrites).toEqual([
        { evaluationId: 7, evaluationDate: STORAGE_DATE },
      ]);
    });

    it('is idempotent in the journal when retried for the same evaluation and day', async () => {
      const { d, h, steps, journal, report } = setup();

      await steps.saveToStorage(h.job, 7, EVALUATED_AT, report, journal);
      await steps.saveToStorage(h.job, 7, EVALUATED_AT, report, journal);

      expect(d.storeSave).toHaveBeenCalledTimes(2);
      expect(h.data.__rollback?.storageWrites).toHaveLength(1);
    });

    it('rejects an invalid date before journaling or writing anything', async () => {
      const { d, h, steps, journal, report } = setup();

      await expect(steps.saveToStorage(h.job, 7, 'not-a-date', report, journal)).rejects.toThrow(
        RangeError,
      );

      expect(h.updateData).not.toHaveBeenCalled();
      expect(d.storeSave).not.toHaveBeenCalled();
    });
  });

  describe('setPageStatus', () => {
    it.each(['page_contexts_monitor', 'page_contexts_ams'] as const)(
      'updates the page status in %s',
      async (table) => {
        const { d, steps } = setup(table);

        await steps.setPageStatus(PageStatus.FAILED, 10);

        const [sql, params] = d.query.mock.calls[0];
        expect(sql).toContain(`UPDATE ${table}`);
        expect(params).toEqual([PageStatus.FAILED, 10]);
      },
    );
  });
});
