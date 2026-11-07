import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs to stdout. Authorization headers, cookies, keys and bodies never get logged. */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.password', '*.sealed_key', '*.key', 'body'],
      censor: '[redacted]',
    },
  });
}
