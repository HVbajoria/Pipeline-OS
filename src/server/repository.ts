/**
 * Atomic in-memory repository for the server-owned Shared_State.
 *
 * Repository callers receive deep-cloned snapshots and mutate only a draft
 * passed to `transact`. A successful transaction publishes one new revision;
 * a failed transaction publishes nothing. Callers can then use
 * `appendActivity` for the single audit-only commit required for a failed
 * operation.
 */

import { randomUUID } from 'node:crypto';
import type {
  ActivityLogEntry,
  JsonObject,
  LegacySharedState,
  LegacySharedStateWithCatalogs,
  SharedCatalogs,
  SharedState,
  SharedStateWithCatalogs,
  Timestamp
} from '../shared/models';
import {
  createSeed,
  createSeedCatalogs,
  type SeedData
} from './seed';

/** Injectable time source used by operation handlers and tests. */
export interface Clock {
  now(): Timestamp;
}

/** Injectable identifier source used by operation handlers and tests. */
export interface IdGenerator {
  next(prefix?: string): string;
}

/**
 * Server-private idempotency record. The lookup key is a protected scope hash;
 * neither the raw idempotency key nor this record is part of SharedState or a
 * JSON projection. Durable hosts can implement this seam without changing the
 * shared state contract.
 */
export interface InvocationLedgerEntry {
  scopeHash: string;
  requestFingerprint: string;
  operationName: string;
  status: 'success' | 'error';
  responseOrError: JsonObject;
  originalActivityId: string;
  originalRevision: number;
  correlationId: string;
  traceId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface InvocationLedger {
  get(scopeHash: string): InvocationLedgerEntry | undefined;
  set(scopeHash: string, entry: InvocationLedgerEntry): void;
  delete(scopeHash: string): void;
  clear(): void;
  /**
   * Optional scheduled cleanup. Remove every entry whose `expiresAt` is at or
   * before `nowIso` and return how many were pruned. Ledgers that only prune
   * lazily on read may omit this; the maintenance sweep calls it when present.
   */
  prune?(nowIso: Timestamp): number;
}

/** Ephemeral in-memory ledger used by the deterministic demo repository. */
export class InMemoryInvocationLedger implements InvocationLedger {
  private readonly records = new Map<string, InvocationLedgerEntry>();

  get(scopeHash: string): InvocationLedgerEntry | undefined {
    const entry = this.records.get(scopeHash);
    return entry === undefined ? undefined : deepClone(entry);
  }

  set(scopeHash: string, entry: InvocationLedgerEntry): void {
    this.records.set(scopeHash, deepClone(entry));
  }

  delete(scopeHash: string): void {
    this.records.delete(scopeHash);
  }

  clear(): void {
    this.records.clear();
  }

  /** Remove every entry expired at or before `nowIso`; returns the count. */
  prune(nowIso: Timestamp): number {
    const nowMillis = Date.parse(nowIso);
    if (!Number.isFinite(nowMillis)) return 0;
    let pruned = 0;
    for (const [scopeHash, entry] of this.records.entries()) {
      const expiresAt = Date.parse(entry.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= nowMillis) {
        this.records.delete(scopeHash);
        pruned += 1;
      }
    }
    return pruned;
  }

  get size(): number {
    return this.records.size;
  }
}

export class SystemClock implements Clock {
  now(): Timestamp {
    return new Date().toISOString();
  }
}

export class UuidIdGenerator implements IdGenerator {
  next(prefix?: string): string {
    const value = randomUUID();
    return prefix ? `${prefix}-${value}` : value;
  }
}

export const systemClock = new SystemClock();
export const uuidIdGenerator = new UuidIdGenerator();

/** A listener receives an immutable snapshot after each committed revision. */
export type RepositoryListener = (snapshot: SharedStateWithCatalogs) => void;
export type StateListener = RepositoryListener;

export interface SharedStateRepositoryOptions {
  seed?: RepositorySeed;
  /** Seed restored by reset() when no explicit seed is supplied. */
  resetSeed?: RepositorySeed;
  clock?: Clock;
  idGenerator?: IdGenerator;
  /** Server-private idempotency storage; never included in read/snapshot. */
  ledger?: InvocationLedger;
  /** Additive explicit spelling for composition roots. */
  invocationLedger?: InvocationLedger;
}

/** A pre-feature seed bundle accepted during the additive state migration. */
export interface LegacySeedData {
  state: LegacySharedState;
  catalogs: SharedCatalogs;
}

/** A state with catalogs, or a separate state/catalog seed bundle. */
export type RepositorySeed =
  | SharedState
  | SharedStateWithCatalogs
  | LegacySharedState
  | LegacySharedStateWithCatalogs
  | SeedData
  | LegacySeedData;

type RepositorySeedBundle = SeedData | LegacySeedData;
function isSeedBundle(value: unknown): value is RepositorySeedBundle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    'catalogs' in value
  );
}

function isRepositoryOptions(value: unknown): value is SharedStateRepositoryOptions {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'seed' in value ||
    'resetSeed' in value ||
    'clock' in value ||
    'idGenerator' in value ||
    'ledger' in value ||
    'invocationLedger' in value
  );
}

function isClock(value: unknown): value is Clock {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<Clock>).now === 'function'
  );
}

/**
 * Deep clone JSON-safe values while preserving Map instances used by the
 * repository. The state contracts intentionally contain no functions or
 * class instances, but Date and Set support keep this helper safe for future
 * catalog additions.
 */
export function deepClone<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();

  const clone = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;

    const existing = seen.get(input);
    if (existing !== undefined) return existing;

    if (input instanceof Date) {
      const result = new Date(input.getTime());
      seen.set(input, result);
      return result;
    }

    if (input instanceof Map) {
      const result = new Map<unknown, unknown>();
      seen.set(input, result);
      for (const [key, entry] of input.entries()) {
        result.set(clone(key), clone(entry));
      }
      return result;
    }

    if (input instanceof Set) {
      const result = new Set<unknown>();
      seen.set(input, result);
      for (const entry of input.values()) result.add(clone(entry));
      return result;
    }

    if (Array.isArray(input)) {
      const result: unknown[] = [];
      seen.set(input, result);
      for (const entry of input) result.push(clone(entry));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(input, result);
    for (const [key, entry] of Object.entries(input)) {
      result[key] = clone(entry);
    }
    return result;
  };

  return clone(value) as T;
}

function mapFromSeed<K, V>(source: object, key: string): Map<K, V> {
  const value = (source as Record<string, unknown>)[key];
  return value instanceof Map
    ? deepClone(value) as Map<K, V>
    : new Map<K, V>();
}

function normalizeSeed(seed: RepositorySeed): SharedStateWithCatalogs {
  const source = isSeedBundle(seed) ? seed.state : seed;
  const state = deepClone(source) as SharedState | LegacySharedState;
  const catalogs = isSeedBundle(seed)
    ? deepClone(seed.catalogs)
    : 'catalogs' in state && state.catalogs
      ? deepClone(state.catalogs)
      : createSeedCatalogs();

  return {
    ...state,
    approvalCards: mapFromSeed(state, 'approvalCards'),
    sourcedProspects: mapFromSeed(state, 'sourcedProspects'),
    catalogs
  } as SharedStateWithCatalogs;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * In-memory implementation of the Shared_State repository interface.
 *
 * The class is deliberately independent of Express, React, Zustand, and
 * operation-specific handlers. It can therefore be used by the future
 * operation service and by deterministic unit/property-test fixtures.
 */
export class SharedStateRepository {
  private state: SharedStateWithCatalogs;
  private readonly resetSeed: RepositorySeed;
  private readonly listeners = new Set<RepositoryListener>();

  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Server-private ledger dependency; it is deliberately absent from state. */
  readonly invocationLedger: InvocationLedger;

  /** Compatibility alias for hosts that call the dependency simply `ledger`. */
  get ledger(): InvocationLedger {
    return this.invocationLedger;
  }

  constructor(
    seed?: RepositorySeed,
    options?: SharedStateRepositoryOptions | Clock,
    idGenerator?: IdGenerator
  );
  constructor(options?: SharedStateRepositoryOptions);
  constructor(
    seedOrOptions: RepositorySeed | SharedStateRepositoryOptions = createSeed(),
    optionsOrClock: SharedStateRepositoryOptions | Clock = {},
    legacyIdGenerator?: IdGenerator
  ) {
    let seed: RepositorySeed;
    let options: SharedStateRepositoryOptions;

    if (isRepositoryOptions(seedOrOptions)) {
      seed = seedOrOptions.seed ?? createSeed();
      options = seedOrOptions;
    } else {
      seed = seedOrOptions;
      if (isClock(optionsOrClock)) {
        options = {
          clock: optionsOrClock,
          idGenerator: legacyIdGenerator
        };
      } else {
        options = {
          ...optionsOrClock,
          idGenerator: legacyIdGenerator ?? optionsOrClock.idGenerator
        };
      }
    }

    this.state = normalizeSeed(seed);
    this.resetSeed = deepClone(options.resetSeed ?? seed);
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UuidIdGenerator();
    this.invocationLedger =
      options.invocationLedger ?? options.ledger ?? new InMemoryInvocationLedger();
  }

  /** Return an isolated copy of the current map-backed state. */
  read(): SharedStateWithCatalogs {
    return deepClone(this.state);
  }

  /** Alias used by callers that prefer snapshot terminology. */
  snapshot(): SharedStateWithCatalogs {
    return this.read();
  }

  /** Read only the current revision without exposing mutable state. */
  getRevision(): number {
    return this.state.revision;
  }

  get revision(): number {
    return this.getRevision();
  }

  /** Return an isolated copy of the read-only catalogs. */
  getCatalogs(): SharedStateWithCatalogs['catalogs'] {
    return deepClone(this.state.catalogs);
  }

  /** Convenience accessors for injected operation dependencies. */
  now(): Timestamp {
    return this.clock.now();
  }

  nextId(prefix?: string): string {
    return this.idGenerator.next(prefix);
  }

  /**
   * Execute a mutation against a private draft. The optional activity entry
   * is appended to the same draft before the one revision is committed.
   *
   * If the mutator throws, its draft and activity entry are discarded and the
   * original state/revision remains untouched. The operation service can catch
   * the error and call appendActivity once with the failed audit entry.
   */
  transact<T>(
    mutator: (draft: SharedStateWithCatalogs) => T,
    activityEntry?: ActivityLogEntry
  ): T {
    const draft = deepClone(this.state);
    const result = mutator(draft);

    if (isThenable(result)) {
      throw new TypeError(
        'SharedStateRepository.transact expects a synchronous mutator'
      );
    }

    if (activityEntry !== undefined) {
      draft.activityLog.push(deepClone(activityEntry));
    }

    this.commit(draft);
    return deepClone(result);
  }

  /**
   * Async counterpart to `transact` for operation handlers that perform
   * asynchronous work before returning their output. The draft remains
   * private until the handler resolves successfully, so rejected handlers do
   * not publish domain changes or an activity entry.
   */
  async transactAsync<T>(
    mutator: (
      draft: SharedStateWithCatalogs
    ) => T | PromiseLike<T>,
    activityEntry?: ActivityLogEntry
  ): Promise<T> {
    const draft = deepClone(this.state);
    const result = await mutator(draft);

    if (activityEntry !== undefined) {
      draft.activityLog.push(deepClone(activityEntry));
    }

    this.commit(draft);
    return deepClone(result);
  }

  /**
   * Append an audit entry as its own atomic revision. This is the operation
   * service's failure path: domain collections remain exactly as they were,
   * while the failed invocation becomes visible to subscribers.
   */
  appendActivity(entry: ActivityLogEntry): SharedStateWithCatalogs {
    const draft = deepClone(this.state);
    draft.activityLog.push(deepClone(entry));
    this.commit(draft);
    return this.read();
  }

  /**
   * Replace mutable state and catalogs with a deep clone of a deterministic
   * seed. Reset is a committed repository event, so revisions remain
   * monotonically increasing for subscribers even though domain collections
   * return to their seed values.
   */
  reset(seed: RepositorySeed = this.resetSeed): SharedStateWithCatalogs {
    const next = normalizeSeed(seed);
    // Demo approval/provenance and idempotency records are ephemeral. A
    // durable host may supply a ledger with its own retention policy, but the
    // in-memory seam is cleared with reset so retries cannot cross demo data.
    this.invocationLedger.clear();
    this.commit(next);
    return this.read();
  }

  /**
   * Expire approval cards whose deadline has passed. Cards are otherwise only
   * transitioned lazily when an operation touches them, which leaks `pending`/
   * `approved` cards in a long-running durable store. The scheduled maintenance
   * sweep calls this so terminal state is reached even without further traffic.
   *
   * `nowIso` defaults to the injected clock. Returns the ids that were expired;
   * when none change, no revision is committed.
   */
  sweepExpiredApprovalCards(nowIso: Timestamp = this.clock.now()): string[] {
    const nowMillis = Date.parse(nowIso);
    if (!Number.isFinite(nowMillis)) return [];
    const expiredIds: string[] = [];
    for (const [id, card] of this.state.approvalCards.entries()) {
      const expiresAt = Date.parse(card.expiresAt);
      if (
        (card.status === 'pending' || card.status === 'approved') &&
        Number.isFinite(expiresAt) &&
        nowMillis >= expiresAt
      ) {
        expiredIds.push(id);
      }
    }
    if (expiredIds.length === 0) return [];
    this.transact((draft) => {
      for (const id of expiredIds) {
        const card = draft.approvalCards.get(id);
        if (card !== undefined) card.status = 'expired';
      }
    });
    return expiredIds;
  }

  /** Subscribe to committed snapshots; returns an idempotent unsubscribe. */
  subscribe(listener: RepositoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected commit(next: SharedStateWithCatalogs): void {
    const committed = deepClone(next);
    committed.revision = this.state.revision + 1;
    this.applyCommittedState(committed);
  }

  /**
   * Replace the authoritative state with an already-finalized snapshot (its
   * `revision` is used as-is) and notify subscribers. The base `commit`
   * increments the revision before delegating here; a durable subclass can
   * also use this to adopt a snapshot produced by another instance without
   * minting a new revision.
   */
  protected applyCommittedState(committed: SharedStateWithCatalogs): void {
    this.state = committed;

    const snapshot = this.read();
    for (const listener of this.listeners) {
      try {
        listener(deepClone(snapshot));
      } catch {
        // A subscriber is observational; one faulty listener must not turn a
        // successful repository commit into a failed mutation.
      }
    }
  }
}

/** Factory that makes the default dependency boundary explicit. */
export function createRepository(
  seed: RepositorySeed = createSeed(),
  options: Omit<SharedStateRepositoryOptions, 'seed'> = {}
): SharedStateRepository {
  return new SharedStateRepository(seed, options);
}

// Conventional aliases for composition roots and test fixtures.
export const InMemorySharedStateRepository = SharedStateRepository;
export const createSharedStateRepository = createRepository;
export type SharedStateStore = SharedStateRepository;
