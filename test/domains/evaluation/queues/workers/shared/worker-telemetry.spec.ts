import { metrics, trace } from '@opentelemetry/api';
import type { Meter, Tracer } from '@opentelemetry/api';
import { createWorkerTelemetry } from '@evaluation/queues/workers/shared/worker-telemetry';

interface FakeCounter {
  add: jest.Mock;
}
interface FakeHistogram {
  record: jest.Mock;
}

describe('createWorkerTelemetry', () => {
  const counters = new Map<string, FakeCounter>();
  const histograms = new Map<string, FakeHistogram>();
  let createCounter: jest.Mock;
  let createHistogram: jest.Mock;
  let getMeter: jest.SpyInstance;
  let getTracer: jest.SpyInstance;
  const tracer = { name: 'fake-tracer' };

  beforeEach(() => {
    counters.clear();
    histograms.clear();
    createCounter = jest.fn((name: string) => {
      const counter = { add: jest.fn() };
      counters.set(name, counter);
      return counter;
    });
    createHistogram = jest.fn((name: string) => {
      const histogram = { record: jest.fn() };
      histograms.set(name, histogram);
      return histogram;
    });
    const meter = { createCounter, createHistogram } as unknown as Meter;
    getMeter = jest.spyOn(metrics, 'getMeter').mockReturnValue(meter);
    getTracer = jest.spyOn(trace, 'getTracer').mockReturnValue(tracer as unknown as Tracer);
  });

  afterEach(() => {
    getMeter.mockRestore();
    getTracer.mockRestore();
  });

  it('scopes the tracer and meter to the worker name', () => {
    const telemetry = createWorkerTelemetry('private');

    expect(getTracer).toHaveBeenCalledWith('evaluation-private-worker');
    expect(getMeter).toHaveBeenCalledWith('evaluation-private-worker');
    expect(telemetry.tracer).toBe(tracer);
  });

  it('prefixes every instrument with evaluation.<worker>', () => {
    createWorkerTelemetry('public');

    expect([...counters.keys()].sort()).toEqual([
      'evaluation.public.jobs.dead_lettered',
      'evaluation.public.jobs.failed_final',
      'evaluation.public.jobs.processed',
    ]);
    expect([...histograms.keys()]).toEqual(['evaluation.public.job.duration']);
    expect(createHistogram).toHaveBeenCalledWith(
      'evaluation.public.job.duration',
      expect.objectContaining({ unit: 'ms' }),
    );
  });

  it('keeps public and private instruments apart', () => {
    createWorkerTelemetry('public');
    createWorkerTelemetry('private');

    expect(counters.has('evaluation.public.jobs.processed')).toBe(true);
    expect(counters.has('evaluation.private.jobs.processed')).toBe(true);
  });

  it.each(['success', 'failure'] as const)('records a %s outcome with its duration', (outcome) => {
    const telemetry = createWorkerTelemetry('public');

    telemetry.recordJob(outcome, 120);

    expect(counters.get('evaluation.public.jobs.processed')?.add).toHaveBeenCalledWith(1, {
      outcome,
    });
    expect(histograms.get('evaluation.public.job.duration')?.record).toHaveBeenCalledWith(120, {
      outcome,
    });
  });

  it('counts final failures without attributes', () => {
    const telemetry = createWorkerTelemetry('public');

    telemetry.recordFinalFailure();

    expect(counters.get('evaluation.public.jobs.failed_final')?.add).toHaveBeenCalledWith(1);
  });

  it('counts dead-lettered jobs without attributes', () => {
    const telemetry = createWorkerTelemetry('public');

    telemetry.recordDeadLettered();

    expect(counters.get('evaluation.public.jobs.dead_lettered')?.add).toHaveBeenCalledWith(1);
  });

  it('never records high-cardinality attributes', () => {
    const telemetry = createWorkerTelemetry('public');

    telemetry.recordJob('success', 5);
    telemetry.recordFinalFailure();
    telemetry.recordDeadLettered();

    for (const counter of counters.values()) {
      for (const [, attributes] of counter.add.mock.calls) {
        expect(
          Object.keys((attributes ?? {}) as object).filter((key) => key !== 'outcome'),
        ).toEqual([]);
      }
    }
  });
});
