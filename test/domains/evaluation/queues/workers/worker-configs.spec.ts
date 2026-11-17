import type { Job } from 'bullmq';
import type { EvaluationJobData } from '@evaluation/types';
import PUBLIC_CONFIG from '@domains/evaluation/queues/workers/public/evaluation.public.config';
import PRIVATE_CONFIG from '@domains/evaluation/queues/workers/private/evaluation.private.config';
import { createJobHarness } from 'test/helpers/worker-test-utils';

const NOW = new Date('2024-06-01T12:00:00.000Z');

describe('worker configs', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('public', () => {
    it('is wired to the monitor table and the public context', () => {
      expect(PUBLIC_CONFIG).toMatchObject({
        name: 'public',
        loggerContext: 'EvaluationPublicWorker',
        contextId: 2,
        pageTable: 'page_contexts_monitor',
      });
    });

    it('exposes the website id as span attribute', () => {
      const h = createJobHarness();

      expect(PUBLIC_CONFIG.spanAttributes(h.job as Job<EvaluationJobData>)).toEqual({
        'evaluation.website_id': 5,
      });
    });

    it('builds a flat DLQ payload', () => {
      const h = createJobHarness();
      const error = new Error('boom');

      expect(PUBLIC_CONFIG.buildDlqPayload(h.job as Job<EvaluationJobData>, error)).toEqual({
        originalJobId: 'job-1',
        data: h.data,
        failedReason: 'boom',
        stacktrace: error.stack,
        failedAt: NOW.toISOString(),
      });
    });
  });

  describe('private', () => {
    it('is wired to the AMS table and the private context', () => {
      expect(PRIVATE_CONFIG).toMatchObject({
        name: 'private',
        loggerContext: 'EvaluationPrivateWorker',
        contextId: 1,
        pageTable: 'page_contexts_ams',
      });
    });

    it('exposes the institution id as span attribute', () => {
      const h = createJobHarness();

      expect(PRIVATE_CONFIG.spanAttributes(h.job as Job<EvaluationJobData>)).toEqual({
        'evaluation.institution_id': 3,
      });
    });

    it('builds a DLQ payload with a nested error', () => {
      const h = createJobHarness();
      const error = new Error('boom');

      expect(PRIVATE_CONFIG.buildDlqPayload(h.job as Job<EvaluationJobData>, error)).toEqual({
        originalJobId: 'job-1',
        data: h.data,
        error: { message: 'boom', stack: error.stack },
        failedAt: NOW.toISOString(),
      });
    });
  });

  it('uses distinct contexts and tables for each worker', () => {
    expect(PUBLIC_CONFIG.contextId).not.toBe(PRIVATE_CONFIG.contextId);
    expect(PUBLIC_CONFIG.pageTable).not.toBe(PRIVATE_CONFIG.pageTable);
  });
});
