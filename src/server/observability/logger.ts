/**
 * Structured logging for PipelineOS.
 *
 * Replaces ad-hoc `console.log`/`console.error` with a single pino-based JSON
 * logger. In production it emits one JSON object per line (the shape Cloud
 * Run, Cloud Logging, and most aggregators ingest directly); in development it
 * pretty-prints for readability. Correlation and trace ids already flow through
 * the system (`X-Correlation-Id`, activity `traceId`), so `childLogger` binds
 * them to every line for a request or operation.
 *
 * The logger is created lazily and can be replaced by a composition root or a
 * test via `setLogger`, keeping the rest of the server decoupled from pino.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/** Fields we consistently attach so logs are queryable across the system. */
export interface LogContext {
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  operation?: string;
  actorType?: string;
  actorId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function resolveLevel(): string {
  const level = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (level !== undefined && level.length > 0) return level;
  if (process.env.NODE_ENV === 'test') return 'silent';
  return isProduction() ? 'info' : 'debug';
}

function buildLogger(): Logger {
  const options: LoggerOptions = {
    level: resolveLevel(),
    // Never let a log line leak secrets that may appear on bound context.
    redact: {
      paths: [
        'accessToken',
        'authorization',
        'req.headers.authorization',
        'req.headers.cookie',
        'claims.accessToken',
        'serviceAccount',
        'private_key'
      ],
      censor: '[redacted]'
    },
    base: { service: 'pipelineos' }
  };

  // Pretty output in development only; production stays pure JSON. pino-pretty
  // is a devDependency, so guard the transport behind the non-production path.
  if (!isProduction() && process.env.NODE_ENV !== 'test') {
    try {
      return pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
        }
      });
    } catch {
      // Fall back to plain JSON if the pretty transport is unavailable.
    }
  }
  return pino(options);
}

let rootLogger: Logger | undefined;

/** The shared root logger, created on first use. */
export function getLogger(): Logger {
  if (rootLogger === undefined) rootLogger = buildLogger();
  return rootLogger;
}

/** Replace the root logger (composition root / tests). */
export function setLogger(logger: Logger): void {
  rootLogger = logger;
}

/** A child logger with bound context (correlation/trace ids, actor, etc.). */
export function childLogger(context: LogContext): Logger {
  const bindings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) bindings[key] = value;
  }
  return getLogger().child(bindings);
}
