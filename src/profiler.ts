import { monitorEventLoopDelay } from 'node:perf_hooks';
import process from 'node:process';

// 1. Inicia o monitor de Event Loop nativo da libuv (amostragem a cada 10ms)
const elMonitor = monitorEventLoopDelay({ resolution: 10 });
elMonitor.enable();

// 2. Snapshots iniciais para cálculo diferencial
let lastCpu = process.cpuUsage();
let lastHr = process.hrtime();

const INTERVAL_MS = 5000;

const intervalTimer = setInterval(() => {
  // Delta de CPU e Delta de tempo real (Wall-Clock)
  const cpuDiff = process.cpuUsage(lastCpu);
  const hrDiff = process.hrtime(lastHr);

  lastCpu = process.cpuUsage();
  lastHr = process.hrtime();

  // Converter tudo para microsegundos
  const elapsedMicros = hrDiff[0] * 1_000_000 + hrDiff[1] / 1_000;
  const cpuMicros = cpuDiff.user + cpuDiff.system;

  // CPU % normalizado a 1 core (100% = 1 core totalmente saturado)
  const cpuPercent = elapsedMicros > 0 ? (cpuMicros / elapsedMicros) * 100 : 0;

  // Nanosegundos -> Milissegundos
  const p50 = (elMonitor.percentile(50) / 1_000_000).toFixed(2);
  const p95 = (elMonitor.percentile(95) / 1_000_000).toFixed(2);
  const p99 = (elMonitor.percentile(99) / 1_000_000).toFixed(2);
  const max = (elMonitor.max / 1_000_000).toFixed(2);

  // Memória Heap alocada
  const mem = process.memoryUsage();
  const heapUsedMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotalMb = (mem.heapTotal / 1024 / 1024).toFixed(1);

  // Timestamp ISO legível
  const timestamp = new Date().toISOString().substring(11, 19);

  console.log(`\n[${timestamp}] --- HEALTH CHECK (Últimos 5s) ---`);
  console.table([
    {
      'CPU (%)': `${cpuPercent.toFixed(1)}%`,
      'EL Lag p50': `${p50} ms`,
      'EL Lag p95': `${p95} ms`,
      'EL Lag p99': `${p99} ms`,
      'EL Lag Max': `${max} ms`,
      'Heap Memory': `${heapUsedMb} / ${heapTotalMb} MB`,
    },
  ]);

  // CRÍTICO: Reset ao histograma para limpar a janela dos 5 segundos anteriores
  elMonitor.reset();
}, INTERVAL_MS);

// Permite ao processo encerrar graciosamente sem ficar preso por este timer
intervalTimer.unref();
