/**
 * Pure invocation-metadata normalization and request-fingerprint material.
 *
 * Correlation, idempotency, and parent-span values are transport concerns. The
 * fingerprint builder intentionally excludes them so a retry can use a new
 * correlation/trace context without changing the logical request identity.
 */

import { ValidationError } from '../errors';
import type {
  ActorContext,
  InvocationMetadata,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue
} from '../models';
import { INVOCATION_METADATA_LIMITS } from '../models';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const MAX_ACTOR_ID_LENGTH = 128;

export interface RequestFingerprintInput {
  operationName: string;
  input: JsonObject;
  actorScope: ActorContext;
  approvalId?: string;
  expectedRevision?: number;
}

export interface RequestFingerprintInputOptions {
  operationName: string;
  input: unknown;
  actor: ActorContext;
  metadata?: InvocationMetadata | unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(field: string, message: string, keyword?: string): never {
  throw new ValidationError(message, {
    field,
    ...(keyword === undefined
      ? {}
      : { issues: [{ path: field, message, keyword }] })
  });
}

function normalizeSafeIdentifier(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== 'string') {
    return invalid(field, `${field} must be a string`, 'type');
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return invalid(field, `${field} contains unsupported control characters`, 'pattern');
  }
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0) {
    return invalid(field, `${field} must not be empty`, 'minLength');
  }
  if (normalized.length > maxLength) {
    return invalid(
      field,
      `${field} must be at most ${maxLength} characters`,
      'maxLength'
    );
  }
  return normalized;
}

function normalizeActor(actor: unknown, field = 'actor'): ActorContext {
  if (!isPlainRecord(actor)) {
    return invalid(field, `${field} must be an actor object`, 'type');
  }
  const extra = Object.keys(actor).find((key) => !['actorType', 'actorId'].includes(key));
  if (extra !== undefined) {
    return invalid(`${field}.${extra}`, `${field}.${extra} is not an allowed property`, 'additionalProperties');
  }
  if (actor.actorType !== 'human_ui' && actor.actorType !== 'agent') {
    return invalid(`${field}.actorType`, `${field}.actorType is not supported`, 'enum');
  }
  return {
    actorType: actor.actorType,
    actorId: normalizeSafeIdentifier(actor.actorId, `${field}.actorId`, MAX_ACTOR_ID_LENGTH)
  };
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

function canonicalJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object> = new WeakSet<object>()
): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return invalid(path, `${path} must contain finite JSON numbers`, 'type');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return invalid(path, `${path} contains a circular reference`, 'circular');
    }
    ancestors.add(value);
    const result = value.map((item, index) =>
      canonicalJsonValue(item, `${path}[${index}]`, ancestors)
    ) as JsonArray;
    ancestors.delete(value);
    return result;
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) {
      return invalid(path, `${path} contains a circular reference`, 'circular');
    }
    ancestors.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (CONTROL_CHARACTER_PATTERN.test(key)) {
        return invalid(`${path}.${key}`, `${path}.${key} contains control characters`, 'pattern');
      }
      const item = value[key];
      if (
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint'
      ) {
        return invalid(`${path}.${key}`, `${path}.${key} is not JSON serializable`, 'type');
      }
      defineJsonProperty(
        result,
        key,
        canonicalJsonValue(item, `${path}.${key}`, ancestors)
      );
    }
    ancestors.delete(value);
    return result as JsonObject;
  }
  return invalid(path, `${path} must be a JSON value`, 'type');
}

/** Canonicalize JSON recursively with sorted object keys and preserved array order. */
export function canonicalizeJsonValue(value: unknown, field = 'value'): JsonValue {
  return canonicalJsonValue(value, field);
}

export function canonicalizeJsonObject(value: unknown, field = 'input'): JsonObject {
  if (!isPlainRecord(value)) {
    return invalid(field, `${field} must be a JSON object`, 'type');
  }
  return canonicalJsonValue(value, field) as JsonObject;
}

/** Byte-stable JSON representation suitable for hashing at a server boundary. */
export function canonicalJsonString(value: unknown, field = 'value'): string {
  return JSON.stringify(canonicalizeJsonValue(value, field));
}

export const stableJsonStringify = canonicalJsonString;

/** Normalize the additive metadata envelope without adding generated values. */
export function normalizeInvocationMetadata(
  metadata: unknown
): InvocationMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (!isPlainRecord(metadata)) {
    return invalid('metadata', 'invocation metadata must be an object', 'type');
  }

  const allowed = [
    'correlationId',
    'idempotencyKey',
    'expectedRevision',
    'approvalId',
    'parentSpanId'
  ];
  const extra = Object.keys(metadata).find((key) => !allowed.includes(key));
  if (extra !== undefined) {
    return invalid(`metadata.${extra}`, `metadata.${extra} is not an allowed property`, 'additionalProperties');
  }

  const normalized: InvocationMetadata = {};
  if (metadata.correlationId !== undefined) {
    normalized.correlationId = normalizeSafeIdentifier(
      metadata.correlationId,
      'metadata.correlationId',
      INVOCATION_METADATA_LIMITS.correlationId
    );
  }
  if (metadata.idempotencyKey !== undefined) {
    normalized.idempotencyKey = normalizeSafeIdentifier(
      metadata.idempotencyKey,
      'metadata.idempotencyKey',
      INVOCATION_METADATA_LIMITS.idempotencyKey
    );
  }
  if (metadata.expectedRevision !== undefined) {
    if (
      typeof metadata.expectedRevision !== 'number' ||
      !Number.isSafeInteger(metadata.expectedRevision) ||
      metadata.expectedRevision < 0
    ) {
      return invalid(
        'metadata.expectedRevision',
        'metadata.expectedRevision must be a non-negative safe integer',
        'minimum'
      );
    }
    normalized.expectedRevision = metadata.expectedRevision;
  }
  if (metadata.approvalId !== undefined) {
    normalized.approvalId = normalizeSafeIdentifier(
      metadata.approvalId,
      'metadata.approvalId',
      INVOCATION_METADATA_LIMITS.approvalId
    );
  }
  if (metadata.parentSpanId !== undefined) {
    normalized.parentSpanId = normalizeSafeIdentifier(
      metadata.parentSpanId,
      'metadata.parentSpanId',
      INVOCATION_METADATA_LIMITS.parentSpanId
    );
  }
  return normalized;
}

export const canonicalizeInvocationMetadata = normalizeInvocationMetadata;
export const validateInvocationMetadata = normalizeInvocationMetadata;

function requestFingerprintOptions(
  first: string | RequestFingerprintInputOptions,
  input?: unknown,
  actor?: ActorContext,
  metadata?: InvocationMetadata | unknown
): RequestFingerprintInputOptions {
  if (typeof first === 'string') {
    return {
      operationName: first,
      input,
      actor: actor as ActorContext,
      metadata
    };
  }
  return first;
}

/**
 * Build the canonical, JSON-safe material a later service may hash. The raw
 * idempotency key, correlation ID, and parent span are deliberately absent.
 */
export function buildRequestFingerprintInput(
  options: RequestFingerprintInputOptions
): RequestFingerprintInput;
export function buildRequestFingerprintInput(
  operationName: string,
  input: unknown,
  actor: ActorContext,
  metadata?: InvocationMetadata | unknown
): RequestFingerprintInput;
export function buildRequestFingerprintInput(
  first: string | RequestFingerprintInputOptions,
  input?: unknown,
  actor?: ActorContext,
  metadata?: InvocationMetadata | unknown
): RequestFingerprintInput {
  const options = requestFingerprintOptions(first, input, actor, metadata);
  const operationName = normalizeSafeIdentifier(
    options.operationName,
    'operationName',
    160
  );
  const actorScope = normalizeActor(options.actor, 'actor');
  const normalizedMetadata = normalizeInvocationMetadata(options.metadata);
  const normalizedInput = canonicalizeJsonObject(options.input, 'input');

  const result: RequestFingerprintInput = {
    operationName,
    input: normalizedInput,
    actorScope
  };
  if (normalizedMetadata?.approvalId !== undefined) {
    result.approvalId = normalizedMetadata.approvalId;
  }
  if (normalizedMetadata?.expectedRevision !== undefined) {
    result.expectedRevision = normalizedMetadata.expectedRevision;
  }
  return result;
}

export const buildSafeRequestFingerprintInput = buildRequestFingerprintInput;
export const createRequestFingerprintInput = buildRequestFingerprintInput;

/** Return the stable string that a crypto/hash boundary can consume later. */
export function requestFingerprintCanonicalString(
  options: RequestFingerprintInputOptions
): string;
export function requestFingerprintCanonicalString(
  operationName: string,
  input: unknown,
  actor: ActorContext,
  metadata?: InvocationMetadata | unknown
): string;
export function requestFingerprintCanonicalString(
  first: string | RequestFingerprintInputOptions,
  input?: unknown,
  actor?: ActorContext,
  metadata?: InvocationMetadata | unknown
): string {
  const fingerprintInput =
    typeof first === 'string'
      ? buildRequestFingerprintInput(first, input, actor as ActorContext, metadata)
      : buildRequestFingerprintInput(first);
  return canonicalJsonString(fingerprintInput, 'requestFingerprint');
}

export const getRequestFingerprintCanonicalString = requestFingerprintCanonicalString;

// Keep JsonPrimitive visible to consumers that use this module as their JSON
// canonicalization entry point.
export type { JsonPrimitive, JsonValue };
