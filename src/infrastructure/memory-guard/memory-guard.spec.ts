import { createMemoryGuard } from './memory-guard';

describe('createMemoryGuard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not trigger onExceeded while heap stays under the limit', () => {
    const onExceeded = jest.fn();
    const readHeapUsedMb = jest.fn().mockReturnValue(100);

    createMemoryGuard({
      limitMb: 350,
      checkIntervalMs: 1000,
      onExceeded,
      readHeapUsedMb,
    });

    jest.advanceTimersByTime(5000);

    expect(onExceeded).not.toHaveBeenCalled();
  });

  it('triggers onExceeded exactly once when heap crosses the limit', () => {
    const onExceeded = jest.fn();
    let heapUsedMb = 100;
    const readHeapUsedMb = jest.fn(() => heapUsedMb);

    createMemoryGuard({
      limitMb: 350,
      checkIntervalMs: 1000,
      onExceeded,
      readHeapUsedMb,
    });

    jest.advanceTimersByTime(2000);
    expect(onExceeded).not.toHaveBeenCalled();

    heapUsedMb = 400;
    jest.advanceTimersByTime(5000);

    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it('stops checking after stop() is called', () => {
    const onExceeded = jest.fn();
    const readHeapUsedMb = jest.fn().mockReturnValue(400);

    const guard = createMemoryGuard({
      limitMb: 350,
      checkIntervalMs: 1000,
      onExceeded,
      readHeapUsedMb,
    });

    guard.stop();
    jest.advanceTimersByTime(5000);

    expect(onExceeded).not.toHaveBeenCalled();
  });
});
