export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, trace?: unknown): void;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createLogger(scope: string): Logger {
  return {
    log(message: string): void {
      console.log(`[${timestamp()}] [${scope}] ${message}`);
    },
    warn(message: string): void {
      console.warn(`[${timestamp()}] [${scope}] ${message}`);
    },
    error(message: string, trace?: unknown): void {
      console.error(`[${timestamp()}] [${scope}] ${message}`, trace ?? '');
    },
  };
}
