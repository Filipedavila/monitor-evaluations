import { monitorEventLoopDelay, IntervalHistogram } from 'node:perf_hooks';
import process from 'node:process';

export class ProcessMetricsCollector {
  private histogram: IntervalHistogram;
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuTime: [number, number]; // [seconds, nanoseconds] via process.hrtime()
  private intervalTimer?: NodeJS.Timeout;

  constructor(private readonly resolutionMs = 10) {
    // resolution: granularidade de amostragem na libuv em ms
    this.histogram = monitorEventLoopDelay({ resolution: this.resolutionMs });
  }

  public start(sampleIntervalMs = 5000): void {
    this.histogram.enable();
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = process.hrtime();

    this.intervalTimer = setInterval(() => {
      this.collect();
    }, sampleIntervalMs);

    // Evita prender o encerramento gracioso do processo
    this.intervalTimer.unref();
  }

  public stop(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.histogram.disable();
  }

  private collect(): void {
    // 1. Delta de CPU e Wall-Clock Time
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const hrDuration = process.hrtime(this.lastCpuTime);

    // Atualizar referências para o próximo intervalo
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = process.hrtime();

    // Duração total em microssegundos
    const elapsedMicros = hrDuration[0] * 1_000_000 + hrDuration[1] / 1_000;
    const cpuTotalMicros = currentCpuUsage.user + currentCpuUsage.system;

    // Percentagem relativa a 1 core (100% = 1 core saturado)
    // Se o processo saturar múltiplos workers/libuv threads, o total pode exceder 100%.
    const cpuPercentage = elapsedMicros > 0 ? (cpuTotalMicros / elapsedMicros) * 100 : 0;

    const p50 = this.histogram.percentile(50) / 1_000_000;
    const p99 = this.histogram.percentile(99) / 1_000_000;
    const max = this.histogram.max / 1_000_000;

    this.histogram.reset();

    this.emit({
      cpu: {
        percent: Number(cpuPercentage.toFixed(2)),
        userMicros: currentCpuUsage.user,
        systemMicros: currentCpuUsage.system,
      },
      eventLoopDelayMs: {
        p50: Number(p50.toFixed(2)),
        p99: Number(p99.toFixed(2)),
        max: Number(max.toFixed(2)),
      },
    });
  }

  private emit(payload: Record<string, unknown>): void {
    console.log(JSON.stringify(payload));
  }
}
