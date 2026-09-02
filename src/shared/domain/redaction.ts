/**
 * Shared immutable redaction rules for JSON, Activity Feed payloads, and trace
 * summaries. This module has no transport, repository, clock, or framework
 * dependency; callers choose when to persist or project its return values.
 */

import type {
  ActivityLogEntry,
  ActivityTrace,
  JsonObject,
  JsonValue,
  TraceSpan
} from '../models';

export const REDACTED_ACTIVITY_FIELDS = Object.freeze([
  'accessToken',
  'apiKey',
  'authorization',
  'authorizationHeader',
  'consentEvidence',
  'cookie',
  'contact',
  'email',
  'evidence',
  'evidenceContents',
  'fingerprint',
  'idempotencyKey',
  'normalizedInput',
  'password',
  'phone',
  'raw',
  'rawAccessToken',
  'rawConsentEvidence',
  'rawEvidence',
  'rawPayload',
  'rawResume',
  'requestFingerprint',
  'resume',
  'resumeText',
  'scopeHash',
  'secret',
  'targetFingerprint',
  'token',
  'upstreamPayload'
] as const);

export type RedactionPath = string;

export interface RedactionResult<T> {
  value: T;
  redactions: RedactionPath[];
}

export interface ActivityPayloadToRedact {
  input: JsonObject;
  output: JsonObject;
  trace?: ActivityTrace;
}

export interface RedactedActivityPayload {
  input: JsonObject;
  output: JsonObject;
  trace?: ActivityTrace;
  redactions: RedactionPath[];
}

const SENSITIVE_KEY_NAMES = new Set(
  REDACTED_ACTIVITY_FIELDS.map((key) => normalizeKey(key))
);

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

/**
 * Return true for private transport/source material. Safe public attribution
 * keys such as profileUrl, canonicalSourceUrl, apiUrl, and publicRepos do not
 * match these rules and remain visible.
 */
export function isSensitiveRedactionKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEY_NAMES.has(normalized)) return true;
  return (
    normalized.includes('accesstoken') ||
    normalized.includes('authorization') ||
    (normalized.includes('consentevidence') ||
      (normalized.includes('evidence') && normalized !== 'evidenceref')) ||
    normalized.includes('fingerprint') ||
    normalized.includes('idempotencykey') ||
    normalized.includes('password') ||
    normalized.includes('rawpayload') ||
    normalized.includes('rawresume') ||
    normalized.includes('resume') ||
    normalized.includes('secret') ||
    normalized.includes('upstreampayload') ||
    normalized.includes('contact') ||
    (normalized.endsWith('token') && normalized !== 'tokencount') ||
    normalized === 'emailaddress' ||
    normalized === 'phonenumber' ||
    normalized.endsWith('email') ||
    normalized.endsWith('phone')
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineJsonProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  });
}

function redactValue(
  value: unknown,
  path: string,
  redactions: RedactionPath[],
  ancestors: WeakSet<object> = new WeakSet<object>()
): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      redactions.push(path);
      return null;
    }
    ancestors.add(value);
    const result = value.map((item, index) =>
      redactValue(item, `${path}[${index}]`, redactions, ancestors)
    );
    ancestors.delete(value);
    return result;
  }
  if (!isPlainRecord(value)) return null;
  if (ancestors.has(value)) {
    redactions.push(path);
    return null;
  }
  ancestors.add(value);

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = `${path}.${key}`;
    if (isSensitiveRedactionKey(key)) {
      redactions.push(childPath);
      continue;
    }
    defineJsonProperty(
      result,
      key,
      redactValue(value[key], childPath, redactions, ancestors)
    );
  }
  ancestors.delete(value);
  return result as JsonObject;
}

/** Recursively redact sensitive keys without mutating the supplied value. */
export function redactJsonValue(value: unknown): JsonValue {
  return redactValue(value, '$', []);
}

export function redactJsonValueWithMetadata(value: unknown): RedactionResult<JsonValue> {
  const redactions: RedactionPath[] = [];
  const redacted = redactValue(value, '$', redactions);
  return { value: redacted, redactions: [...new Set(redactions)].sort() };
}

export function redactJsonObject(value: unknown): JsonObject {
  const redacted = redactJsonValue(value);
  return isPlainRecord(redacted) ? (redacted as JsonObject) : {};
}

export function redactJsonObjectWithMetadata(
  value: unknown
): RedactionResult<JsonObject> {
  const result = redactJsonValueWithMetadata(value);
  return {
    value: isPlainRecord(result.value) ? (result.value as JsonObject) : {},
    redactions: result.redactions
  };
}

function redactedTraceSpan(
  span: TraceSpan,
  path: string,
  redactions: RedactionPath[]
): TraceSpan {
  const result: TraceSpan = {
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    status: span.status,
    startedAt: span.startedAt,
    ...(span.completedAt === undefined ? {} : { completedAt: span.completedAt }),
    ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs })
  };
  if (span.summary !== undefined) {
    const summary = redactValue(span.summary, `${path}.summary`, redactions);
    result.summary = isPlainRecord(summary) ? (summary as JsonObject) : {};
  }
  return result;
}

/** Redact a single trace span while preserving its safe lifecycle metadata. */
export function redactTraceSpan(span: TraceSpan): TraceSpan {
  return redactedTraceSpan(span, '$.traceSpan', []);
}

export function redactTraceSpanWithMetadata(span: TraceSpan): RedactionResult<TraceSpan> {
  const redactions: RedactionPath[] = [];
  return {
    value: redactedTraceSpan(span, '$.traceSpan', redactions),
    redactions: [...new Set(redactions)].sort()
  };
}

/** Redact all summaries in an activity trace without changing span ordering. */
export function redactActivityTrace(
  trace: ActivityTrace | undefined
): RedactionResult<ActivityTrace | undefined> {
  if (trace === undefined) return { value: undefined, redactions: [] };
  const redactions: RedactionPath[] = [];
  const value: ActivityTrace = {
    spans: trace.spans.map((span, index) =>
      redactedTraceSpan(span, `$.trace.spans[${index}]`, redactions)
    )
  };
  return {
    value,
    redactions: [...new Set(redactions)].sort()
  };
}

function prefixRedactionPaths(
  paths: readonly RedactionPath[],
  prefix: string
): RedactionPath[] {
  return paths.map((path) => `${prefix}${path === '$' ? '' : path.slice(1)}`);
}

/**
 * Redact the input/output/trace portion shared by activity and approval
 * projections. Existing redaction paths are never mutated or discarded.
 */
export function redactActivityPayload(
  payload: ActivityPayloadToRedact
): RedactedActivityPayload {
  const input = redactJsonObjectWithMetadata(payload.input);
  const output = redactJsonObjectWithMetadata(payload.output);
  const trace = redactActivityTrace(payload.trace);
  return {
    input: input.value,
    output: output.value,
    ...(trace.value === undefined ? {} : { trace: trace.value }),
    redactions: [
      ...new Set([
        ...prefixRedactionPaths(input.redactions, '$.input'),
        ...prefixRedactionPaths(output.redactions, '$.output'),
        ...trace.redactions
      ])
    ].sort()
  };
}

/** Redact a full ActivityLogEntry while preserving optional safe trace links. */
export function redactActivityEntry(entry: ActivityLogEntry): ActivityLogEntry {
  const payload = redactActivityPayload({
    input: entry.input,
    output: entry.output,
    trace: entry.trace
  });
  const redactions = [
    ...new Set([...(entry.redactions ?? []), ...payload.redactions])
  ].sort();
  return {
    id: entry.id,
    toolName: entry.toolName,
    actorType: entry.actorType,
    actorId: entry.actorId,
    input: payload.input,
    output: payload.output,
    timestamp: entry.timestamp,
    ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
    ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }),
    ...(entry.spanId === undefined ? {} : { spanId: entry.spanId }),
    ...(entry.parentSpanId === undefined ? {} : { parentSpanId: entry.parentSpanId }),
    ...(entry.phase === undefined ? {} : { phase: entry.phase }),
    ...(entry.replayed === undefined ? {} : { replayed: entry.replayed }),
    ...(entry.originalActivityId === undefined
      ? {}
      : { originalActivityId: entry.originalActivityId }),
    ...(entry.approvalId === undefined ? {} : { approvalId: entry.approvalId }),
    ...(redactions.length === 0 ? {} : { redactions }),
    ...(payload.trace === undefined ? {} : { trace: payload.trace })
  };
}

export const redactActivity = redactActivityEntry;
export const redactTrace = redactActivityTrace;
export const safeJsonValue = redactJsonValue;
