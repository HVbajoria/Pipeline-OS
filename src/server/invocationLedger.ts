/**
 * Server-private idempotency helpers.
 *
 * The repository owns the injectable ledger storage. This module only builds
 * protected scope/fingerprint keys and handles deterministic expiry; raw
 * idempotency keys and these hashes never enter SharedState projections.
 */

import { createHash } from 'node:crypto';
import type {
  ActorContext,
  InvocationMetadata,
  JsonObject,
  Timestamp
} from '../shared/models';
import {
  canonicalJsonString,
  requestFingerprintCanonicalString
} from '../shared/domain/invocationMetadata';
import type {
  InvocationLedger,
  InvocationLedgerEntry
} from './repository';

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface InvocationScopeInput {
  operationName: string;
  actor: ActorContext;
  idempotencyKey: string;
  tenantId?: string;
  /** Additional trusted scope claims, never serialized outside the hash. */
  scopeClaims?: readonly string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Hash the trusted actor/operation/key scope without retaining the raw key. */
export function createInvocationScopeHash(input: InvocationScopeInput): string {
  return sha256(
    canonicalJsonString({
      operationName: input.operationName,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
      ...(input.scopeClaims === undefined
        ? {}
        : { scopeClaims: [...input.scopeClaims].sort() })
    })
  );
}

export const hashInvocationScope = createInvocationScopeHash;
export const buildInvocationScopeHash = createInvocationScopeHash;

/**
 * Hash canonical request material. The shared builder deliberately excludes
 * correlationId, idempotencyKey, and parentSpanId while retaining normalized
 * input, actor scope, approvalId, and expectedRevision.
 */
export function createInvocationRequestFingerprint(
  operationName: string,
  input: unknown,
  actor: ActorContext,
  metadata?: InvocationMetadata
): string {
  return sha256(
    requestFingerprintCanonicalString(operationName, input, actor, metadata)
  );
}

export const createRequestFingerprint = createInvocationRequestFingerprint;
export const hashRequestFingerprint = createInvocationRequestFingerprint;

export function expiryTimestamp(
  createdAt: Timestamp,
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS
): Timestamp {
  const createdMillis = Date.parse(createdAt);
  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 1;
  if (!Number.isFinite(createdMillis)) return createdAt;
  return new Date(createdMillis + safeTtl).toISOString();
}

export function isInvocationLedgerEntryExpired(
  entry: Pick<InvocationLedgerEntry, 'expiresAt'>,
  now: Timestamp
): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  const nowMillis = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMillis)) return false;
  return expiresAt <= nowMillis;
}

/** Read one live record and remove expired in-memory entries. */
export function getLiveInvocationLedgerEntry(
  ledger: InvocationLedger,
  scopeHash: string,
  now: Timestamp
): InvocationLedgerEntry | undefined {
  const entry = ledger.get(scopeHash);
  if (entry === undefined) return undefined;
  if (isInvocationLedgerEntryExpired(entry, now)) {
    ledger.delete(scopeHash);
    return undefined;
  }
  return entry;
}

/** Keep ledger response values detached from repository and caller objects. */
export function cloneLedgerJson(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
