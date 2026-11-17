import { createFailureHandler } from '@domains/evaluation/queues/workers/shared/failure-handler';
import { PageStatus } from '@evaluation/domain/evaluation.constants';
import type { WorkerConfig } from '@domains/evaluation/queues/workers/shared/worker.types';
import {
  buildConfig,
  createDepsHarness,
  createJobHarness,
  createLoggerHarness,
  createTelemetryHarness,
  firstCallOrder,
} from 'test/helpers/worker-test-utils';

function setup(config: WorkerConfig = buildConfig()) {
  const d = createDepsHarness();
  const h = createJobHarness();
  const l = createLoggerHarness();
  const t = createTelemetryHarness();
  const handle = createFailureHandler(d.deps, config, l.logger, t.telemetry);
  return { d, h, l, t, config, handle };
}

describe('createFailureHandler', () => {
  it('records the final failure and sends the job to the DLQ with the configured payload', async () => {
    const { d, h, t, config, handle } = setup();
    const error = new Error('boom');

    await handle(h.job, error);

    expect(t.recordFinalFailure).toHaveBeenCalledTimes(1);
    expect(config.buildDlqPayload).toHaveBeenCalledWith(h.job, error);
    expect(d.dlqAdd).toHaveBeenCalledWith('failed-job', {
      originalJobId: 'job-1',
      failedReason: 'boom',
    });
    expect(t.recordDeadLettered).toHaveBeenCalledTimes(1);
  });

  it('marks the page as FAILED in the worker table', async () => {
    const { d, h, handle } = setup(buildConfig({ pageTable: 'page_contexts_ams' }));

    await handle(h.job, new Error('boom'));

    const [sql, params] = d.query.mock.calls[0];
    expect(sql).toContain('page_contexts_ams');
    expect(params).toEqual([PageStatus.FAILED, 10]);
  });

  it('emits evaluation.failed with the job data and the error message', async () => {
    const { d, h, handle } = setup();

    await handle(h.job, new Error('boom'));

    expect(d.emit).toHaveBeenCalledWith('evaluation.failed', {
      jobData: h.data,
      error: 'boom',
    });
  });

  it('runs in order: final failure metric, DLQ, page status', async () => {
    const { d, h, t, handle } = setup();

    await handle(h.job, new Error('boom'));

    expect(firstCallOrder(t.recordFinalFailure)).toBeLessThan(firstCallOrder(d.dlqAdd));
    expect(firstCallOrder(d.dlqAdd)).toBeLessThan(firstCallOrder(d.query));
  });

  describe('resilience', () => {
    it('logs a DLQ failure, skips the dead-letter metric and still marks the page as failed', async () => {
      const { d, h, l, t, handle } = setup();
      d.dlqAdd.mockRejectedValue(new Error('dlq down'));

      await expect(handle(h.job, new Error('boom'))).resolves.toBeUndefined();

      expect(l.error).toHaveBeenCalledWith('Failed to push job job-1 to DLQ: dlq down');
      expect(t.recordDeadLettered).not.toHaveBeenCalled();
      expect(d.query).toHaveBeenCalledTimes(1);
      expect(d.emit).toHaveBeenCalledWith('evaluation.failed', expect.anything());
    });

    it('stringifies non-Error DLQ failures', async () => {
      const { d, h, l, handle } = setup();
      d.dlqAdd.mockRejectedValue('dlq plain failure');

      await handle(h.job, new Error('boom'));

      expect(l.error).toHaveBeenCalledWith('Failed to push job job-1 to DLQ: dlq plain failure');
    });

    it('treats a throwing payload builder as a DLQ failure', async () => {
      const config = buildConfig({
        buildDlqPayload: () => {
          throw new Error('payload failure');
        },
      });
      const { d, h, l, handle } = setup(config);

      await expect(handle(h.job, new Error('boom'))).resolves.toBeUndefined();

      expect(d.dlqAdd).not.toHaveBeenCalled();
      expect(l.error).toHaveBeenCalledWith('Failed to push job job-1 to DLQ: payload failure');
    });

    it('logs a page status failure and does not emit evaluation.failed', async () => {
      const { d, h, l, handle } = setup();
      d.query.mockRejectedValue(new Error('db down'));

      await expect(handle(h.job, new Error('boom'))).resolves.toBeUndefined();

      expect(l.error).toHaveBeenCalledWith(
        'Falha ao marcar status FAILED para a página 10: db down',
      );
      expect(d.emit).not.toHaveBeenCalled();
    });

    it('logs a throwing event listener without failing', async () => {
      const { d, h, l, handle } = setup();
      d.emit.mockImplementation(() => {
        throw new Error('listener failed');
      });

      await expect(handle(h.job, new Error('boom'))).resolves.toBeUndefined();

      expect(l.error).toHaveBeenCalledWith(
        'Falha ao marcar status FAILED para a página 10: listener failed',
      );
    });

    it('never throws when both the DLQ and the database fail', async () => {
      const { d, h, l, handle } = setup();
      d.dlqAdd.mockRejectedValue(new Error('dlq down'));
      d.query.mockRejectedValue(new Error('db down'));

      await expect(handle(h.job, new Error('boom'))).resolves.toBeUndefined();

      expect(l.error).toHaveBeenCalledTimes(2);
    });
  });
});
