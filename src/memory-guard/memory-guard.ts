export interface MemoryGuardOptions {
  limitMb: number;
  checkIntervalMs: number;
  onExceeded: () => void | Promise<void>;
  readHeapUsedMb?: () => number;
}

export interface MemoryGuard {
  stop(): void;
}

export function createMemoryGuard(options: MemoryGuardOptions): MemoryGuard {
  const readHeapUsedMb =
    options.readHeapUsedMb ?? (() => process.memoryUsage().heapUsed / 1024 / 1024);

  let triggered = false;

  const timer = setInterval(() => {
    if (triggered) return;

    const heapUsedMb = readHeapUsedMb();
    if (heapUsedMb >= options.limitMb) {
      triggered = true;
      clearInterval(timer);
      void options.onExceeded();
    }
  }, options.checkIntervalMs);

  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
