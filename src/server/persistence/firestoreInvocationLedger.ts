/**
 * Firestore-backed idempotency ledger.
 *
 * The `InvocationLedger` interface (see `repository.ts`) is synchronous:
 * `get`/`set`/`delete`/`clear` return immediately because the OperationService
 * consults the ledger inline while serializing an invocation. Firestore is
 * asynchronous, so this implementation is a WRITE-THROUGH CACHE:
 *
 *   - An in-memory `Map` is the synchronous hot path the service reads/writes.
 *   - Every mutation is mirrored to Firestore in the background (fire-and-wait
 *     via a tracked promise) so restarts and other instances see it.
 *   - `load()` hydrates the cache from Firestore at startup, dropping expired
 *     entries, so idempotency keys and their recorded responses survive a
 *     restart and retries are not double-applied.
 *
 * Correctness note: idempotency is a best-effort de-duplication guard, not a
 * distributed lock. A durable, cross-instance guarantee still holds after a
 * restart because entries are reloaded; concurrent writes across instances are
 * last-writer-wins per scope hash, which matches the in-memory semantics.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  deepClone,
  type InvocationLedger,
  type InvocationLedgerEntry
} from '../repository';

export interface FirestoreInvocationLedgerOptions {
  firestore: Firestore;
  /** Firestore collection name. Defaults to `invocation_ledger`. */
  collectionName?: string;
  /**
   * Optional callback invoked when a background Firestore write fails, so a
   * host can log/alert. A failed durable write never breaks the sync path.
   */
  onError?: (error: unknown, context: { operation: string; scopeHash: string }) => void;
}

const DEFAULT_COLLECTION = 'invocation_ledger';

function isExpired(entry: InvocationLedgerEntry, nowMillis: number): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= nowMillis;
}

/**
 * Firestore document ids cannot contain `/` and are capped at 1500 bytes. A
 * scope hash is a hex sha256 (64 chars, no slashes), so it is a safe id, but we
 * guard defensively for any future scope-hash format change.
 */
function documentId(scopeHash: string): string {
  return scopeHash.replace(/\//g, '_').slice(0, 1400);
}

export class FirestoreInvocationLedger implements InvocationLedger {
  private readonly cache = new Map<string, InvocationLedgerEntry>();
  private readonly firestore: Firestore;
  private readonly collectionName: string;
  private readonly onError?: FirestoreInvocationLedgerOptions['onError'];
  /** Tracks outstanding background writes so tests/shutdown can await them. */
  private pending = new Set<Promise<void>>();

  constructor(options: FirestoreInvocationLedgerOptions) {
    this.firestore = options.firestore;
    this.collectionName = options.collectionName ?? DEFAULT_COLLECTION;
    this.onError = options.onError;
  }

  /** Hydrate the in-memory cache from Firestore, dropping expired entries. */
  async load(): Promise<void> {
    const snapshot = await this.firestore.collection(this.collectionName).get();
    const nowMillis = Date.now();
    this.cache.clear();
    const expiredIds: string[] = [];
    snapshot.forEach((doc) => {
      const entry = doc.data() as InvocationLedgerEntry;
      if (entry === undefined || typeof entry.scopeHash !== 'string') return;
      if (isExpired(entry, nowMillis)) {
        expiredIds.push(doc.id);
        return;
      }
      this.cache.set(entry.scopeHash, entry);
    });
    // Opportunistically prune expired documents discovered during load.
    for (const id of expiredIds) {
      this.track('load.prune', id, this.deleteDoc(id));
    }
  }

  get(scopeHash: string): InvocationLedgerEntry | undefined {
    const entry = this.cache.get(scopeHash);
    if (entry === undefined) return undefined;
    if (isExpired(entry, Date.now())) {
      this.delete(scopeHash);
      return undefined;
    }
    return deepClone(entry);
  }

  set(scopeHash: string, entry: InvocationLedgerEntry): void {
    const stored = deepClone(entry);
    this.cache.set(scopeHash, stored);
    this.track(
      'set',
      scopeHash,
      this.firestore
        .collection(this.collectionName)
        .doc(documentId(scopeHash))
        .set(stored as unknown as Record<string, unknown>)
        .then(() => undefined)
    );
  }

  delete(scopeHash: string): void {
    this.cache.delete(scopeHash);
    this.track('delete', scopeHash, this.deleteDoc(documentId(scopeHash)));
  }

  clear(): void {
    this.cache.clear();
    // Delete the whole collection in batches. Reset is an explicit, rare demo
    // action, so a background bulk delete is acceptable.
    this.track('clear', '*', this.clearCollection());
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Remove every entry expired at or before `nowIso` from the cache and, in
   * the background, from Firestore. Returns the number pruned from the cache.
   * The scheduled maintenance sweep calls this so a durable ledger does not
   * accumulate expired documents that are only ever pruned lazily on read.
   */
  prune(nowIso: string): number {
    const nowMillis = Date.parse(nowIso);
    if (!Number.isFinite(nowMillis)) return 0;
    let pruned = 0;
    for (const [scopeHash, entry] of this.cache.entries()) {
      if (isExpired(entry, nowMillis)) {
        this.cache.delete(scopeHash);
        this.track('prune', scopeHash, this.deleteDoc(documentId(scopeHash)));
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Await all outstanding background writes (tests, graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private deleteDoc(id: string): Promise<void> {
    return this.firestore
      .collection(this.collectionName)
      .doc(id)
      .delete()
      .then(() => undefined);
  }

  private async clearCollection(): Promise<void> {
    const collection = this.firestore.collection(this.collectionName);
    // Page through documents to avoid loading an unbounded set at once.
    for (;;) {
      const snapshot = await collection.limit(300).get();
      if (snapshot.empty) return;
      const batch = this.firestore.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      if (snapshot.size < 300) return;
    }
  }

  private track(operation: string, scopeHash: string, work: Promise<void>): void {
    const guarded = work.catch((error) => {
      this.onError?.(error, { operation, scopeHash });
    });
    this.pending.add(guarded);
    void guarded.finally(() => {
      this.pending.delete(guarded);
    });
  }
}
