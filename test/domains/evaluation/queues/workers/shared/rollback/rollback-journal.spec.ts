import { RollbackJournal } from '@domains/evaluation/queues/workers/shared/rollback/rollback-journal';
import type { StorageWrite } from '@domains/evaluation/queues/workers/shared/rollback/rollback-state';
import { createJobHarness } from 'test/helpers/worker-test-utils';

const write = (evaluationId: number, evaluationDate: string): StorageWrite => ({
  evaluationId,
  evaluationDate,
});

describe('RollbackJournal', () => {
  it('stores the id in the journal and as the job evaluationId', async () => {
    const h = createJobHarness();
    await new RollbackJournal(h.job).recordCreatedEvaluation(42);
    expect(h.data.evaluationId).toBe(42);
    expect(h.data.__rollback).toEqual({ createdEvaluationId: 42 });
  });
});
