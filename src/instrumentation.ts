import { NodeSDK } from '@opentelemetry/sdk-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

/**
 * IMPORTANTE: este ficheiro tem de ser o PRIMEIRO import do entrypoint do worker
 * (ex.: `import './instrumentation';` na linha 1), antes de bullmq, ioredis, pg, typeorm, etc.
 *
 * Sem `url`, os exporters leem OTEL_EXPORTER_OTLP_ENDPOINT (base, ex.: http://otel-collector:4318)
 * e acrescentam sozinhos /v1/traces e /v1/metrics. Sem a variável, usam http://localhost:4318.
 */
const traceExporter = new OTLPTraceExporter();
const metricExporter = new OTLPMetricExporter();

const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'monitor-server-worker',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),
  // O NodeSDK embrulha o exporter num BatchSpanProcessor.
  traceExporter,
  // Sem metricReader as métricas nunca saem do processo (o meter fica no-op, sem erro).
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 15_000,
  }),
  contextManager: new AsyncLocalStorageContextManager(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-runtime-node': {
        enabled: false,
      },
    }),
  ],
});

otelSDK.start();

// Graceful shutdown: descarrega spans e métricas pendentes
const shutdown = (signal: string) => {
  otelSDK
    .shutdown()
    .then(() => console.log(`Telemetry SDK terminated (${signal})`))
    .catch((error) => console.error('Error terminating telemetry SDK', error))
    .finally(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default otelSDK;
