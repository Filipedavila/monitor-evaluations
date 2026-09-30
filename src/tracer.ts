import { NodeSDK } from '@opentelemetry/sdk-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  headers: {},
});

const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: 'monitor-server-worker',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  }),
  spanProcessor: new BatchSpanProcessor(traceExporter),
  contextManager: new AsyncLocalStorageContextManager(),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Podes desligar módulos que não uses
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

// 3. Iniciar o runtime de telemetria
otelSDK.start();

// Graceful shutdown para descarregar spans pendentes em SIGTERM/SIGINT
process.on('SIGTERM', () => {
  otelSDK
    .shutdown()
    .then(() => console.log('Tracing SDK terminated'))
    .catch((error) => console.error('Error terminating tracing SDK', error))
    .finally(() => process.exit(0));
});

export default otelSDK;
