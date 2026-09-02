/**
 * Server-side root/child trace construction for operation execution.
 *
 * Trace summaries are intentionally JSON-only and are redacted again by the
 * activity boundary before persistence. The builder exposes no repository,
 * transport, or credential access to operation handlers.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_TRACE_SPANS,
  MAX_TRACE_SUMMARY_PROPERTIES
} from '../shared/operations';
import type {
  ActivityTrace,
  JsonObject,
  SpanId,
  Timestamp,
  TraceId,
  TraceSpan,
  TraceSpanStatus
} from '../shared/models';

/** Runtime limits mirror the shared operation contract rather than relying on validation alone. */
export const MAX_TRACE_NAME_LENGTH = 160;
const MAX_TRACE_SUMMARY_STRING_LENGTH = 1_000;
const MAX_TRACE_SUMMARY_ARRAY_ITEMS = 50;

export interface TraceIdentifierFactory {
  next(prefix: string): string;
}

const randomIdentifierFactory: TraceIdentifierFactory = {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
};

export interface OperationTraceContext {
  readonly traceId: TraceId;
  readonly rootSpanId: SpanId;
  readonly parentSpanId?: SpanId;
  startChild(name: string, summary?: JsonObject): SpanId;
  completeSpan(
    spanId: SpanId,
    status?: Exclude<TraceSpanStatus, 'started'>,
    summary?: JsonObject
  ): void;
  finish(status?: Exclude<TraceSpanStatus, 'started'>, summary?: JsonObject): void;
  snapshot(): ActivityTrace;
}

export interface CreateTraceOptions {
  operationName: string;
  now(): Timestamp;
  traceId?: TraceId;
  parentSpanId?: SpanId;
  identifiers?: TraceIdentifierFactory;
}

function boundedJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.slice(0, MAX_TRACE_SUMMARY_STRING_LENGTH);
  }
  if (depth >= 5) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_TRACE_SUMMARY_ARRAY_ITEMS)
      .map((item) => boundedJsonValue(item, depth + 1));
  }
  if (typeof value !== 'object' || value === undefined) return null;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(
    0,
    MAX_TRACE_SUMMARY_PROPERTIES
  )) {
    result[key.slice(0, MAX_TRACE_NAME_LENGTH)] = boundedJsonValue(child, depth + 1);
  }
  return result;
}

function safeSummary(value: JsonObject | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  try {
    const bounded = boundedJsonValue(value);
    const encoded = JSON.stringify(bounded);
    if (encoded === undefined) return {};
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function safeSpanName(name: string): string {
  const normalized = name.trim();
  return (normalized.length > 0 ? normalized : 'operation.child').slice(
    0,
    MAX_TRACE_NAME_LENGTH
  );
}

function durationMs(startedAt: Timestamp, completedAt: Timestamp): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

class MutableOperationTrace implements OperationTraceContext {
  readonly traceId: TraceId;
  readonly rootSpanId: SpanId;
  readonly parentSpanId?: SpanId;
  private readonly now: () => Timestamp;
  private readonly identifiers: TraceIdentifierFactory;
  private readonly spans: TraceSpan[];

  constructor(options: CreateTraceOptions) {
    this.now = options.now;
    this.identifiers = options.identifiers ?? randomIdentifierFactory;
    this.traceId = options.traceId ?? this.identifiers.next('trace');
    this.rootSpanId = this.identifiers.next('span');
    this.parentSpanId = options.parentSpanId;
    this.spans = [
      {
        spanId: this.rootSpanId,
        ...(options.parentSpanId === undefined
          ? {}
          : { parentSpanId: options.parentSpanId }),
        name: safeSpanName(options.operationName),
        status: 'started',
        startedAt: this.now()
      }
    ];
  }

  startChild(name: string, summary?: JsonObject): SpanId {
    const spanId = this.identifiers.next('span');
    if (this.spans.length >= MAX_TRACE_SPANS) return spanId;
    const normalizedSummary = safeSummary(summary);
    this.spans.push({
      spanId,
      parentSpanId: this.rootSpanId,
      name: safeSpanName(name),
      status: 'started',
      startedAt: this.now(),
      ...(normalizedSummary === undefined ? {} : { summary: normalizedSummary })
    });
    return spanId;
  }

  completeSpan(
    spanId: SpanId,
    status: Exclude<TraceSpanStatus, 'started'> = 'completed',
    summary?: JsonObject
  ): void {
    const span = this.spans.find((candidate) => candidate.spanId === spanId);
    if (span === undefined || span.status !== 'started') return;
    const completedAt = this.now();
    span.status = status;
    span.completedAt = completedAt;
    span.durationMs = durationMs(span.startedAt, completedAt);
    const normalizedSummary = safeSummary(summary);
    if (normalizedSummary !== undefined) span.summary = normalizedSummary;
  }

  finish(
    status: Exclude<TraceSpanStatus, 'started'> = 'completed',
    summary?: JsonObject
  ): void {
    for (const span of this.spans) {
      if (span.status === 'started' && span.spanId !== this.rootSpanId) {
        this.completeSpan(span.spanId, 'skipped');
      }
    }
    this.completeSpan(this.rootSpanId, status, summary);
  }

  snapshot(): ActivityTrace {
    return {
      spans: this.spans.slice(0, MAX_TRACE_SPANS).map((span) => ({
        ...span,
        ...(span.summary === undefined
          ? {}
          : { summary: safeSummary(span.summary) ?? {} })
      }))
    };
  }
}

export function createOperationTrace(
  options: CreateTraceOptions
): OperationTraceContext {
  return new MutableOperationTrace(options);
}

export const createTraceContext = createOperationTrace;
export const createRootTrace = createOperationTrace;
export { randomIdentifierFactory };
