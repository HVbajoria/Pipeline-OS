/**
 * Firestore-backed durable Shared_State repository.
 *
 * The base `SharedStateRepository` keeps the authoritative state in memory and
 * mutates it synchronously (operation handlers call `now()`/`nextId()` and
 * mutate a `transact` draft synchronously). Rewriting every handler to be
 * async would defeat the "single operation path" design, so instead this
 * subclass treats Firestore as a durable, write-through backing store:
 *
 *   - Startup: `create()` reads the last persisted snapshot from Firestore and
 *     seeds the in-memory repository with it, so state survives restarts.
 *   - Write-through: every committed revision (from `transact`, `transactAsync`,
 *     `appendActivity`, or `reset`) is mirrored to a single Firestore document
 *     in the background. The document id is the fixed snapshot key, so the
 *     latest revision always overwrites the previous one.
 *   - Cross-instance sync: an `onSnapshot` listener adopts revisions written by
 *     OTHER instances and notifies local subscribers, so SSE fan-out works when
 *     more than one server is running. Echoes of this instance's own writes are
 *     ignored via the tracked last-written revision.
 *
 * This gives durability and multi-instance consistency without changing the
 * synchronous operation-handler contract.
 */

import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { SharedStateWithCatalogs } from '../../shared/models';
import {
  SharedStateRepository,
  deepClone,
  type InvocationLedger,
  type RepositorySeed,
  type SharedStateRepositoryOptions
} from '../repository';
import {
  deserializeStateFromStorage,
  isSerializedSharedState,
  serializeStateForStorage
} from './stateSerialization';

/** Fixed document id for the single authoritative state snapshot. */
const STATE_DOCUMENT_ID = 'shared_state';
const DEFAULT_COLLECTION = 'pipeline_state';

export interface FirestoreStateRepositoryOptions
  extends SharedStateRepositoryOptions {
  firestore: Firestore;
  /** Collection holding the single snapshot document. Default `pipeline_state`. */
  collectionName?: string;
  /**
   * Adopt revisions written by other instances via Firestore onSnapshot.
   * Default true. Disable for single-instance deployments to save a listener.
   */
  crossInstanceSync?: boolean;
  /** Reports background persistence failures without breaking the sync path. */
  onError?: (error: unknown, context: { operation: string }) => void;
}

export class FirestoreStateRepository extends SharedStateRepository {
  private readonly docRef: DocumentReference;
  private readonly onError?: FirestoreStateRepositoryOptions['onError'];
  private readonly pending = new Set<Promise<void>>();
  /** Revision this instance last persisted, to ignore its own onSnapshot echo. */
  private lastWrittenRevision = -1;
  private unsubscribeRemote?: () => void;

  private constructor(
    seed: RepositorySeed,
    options: FirestoreStateRepositoryOptions
  ) {
    super(seed, options);
    const collectionName = options.collectionName ?? DEFAULT_COLLECTION;
    this.docRef = options.firestore.collection(collectionName).doc(STATE_DOCUMENT_ID);
    this.onError = options.onError;
    this.lastWrittenRevision = this.getRevision();

    // Persist the initial (seed or hydrated) state so the document always
    // exists, then begin write-through on every subsequent committed revision.
    this.persist('init', this.read());
    this.subscribe((snapshot) => {
      // Only persist revisions this instance produced. Adopted remote
      // revisions are already in Firestore and set lastWrittenRevision.
      if (snapshot.revision > this.lastWrittenRevision) {
        this.persist('commit', snapshot);
      }
    });

    if (options.crossInstanceSync !== false) {
      this.startRemoteSync();
    }
  }

  /**
   * Build a durable repository, hydrating from the last persisted snapshot in
   * Firestore when one exists. If no snapshot exists yet, the provided seed
   * (default deterministic seed) is used and immediately persisted.
   */
  static async create(
    options: FirestoreStateRepositoryOptions
  ): Promise<FirestoreStateRepository> {
    const collectionName = options.collectionName ?? DEFAULT_COLLECTION;
    const docRef = options.firestore
      .collection(collectionName)
      .doc(STATE_DOCUMENT_ID);
    const snapshot = await docRef.get();

    let seed: RepositorySeed | undefined = options.seed;
    if (snapshot.exists) {
      const data = snapshot.data();
      if (isSerializedSharedState(data)) {
        seed = deserializeStateFromStorage(data) as unknown as RepositorySeed;
      }
    }

    return new FirestoreStateRepository(
      seed ?? undefined as unknown as RepositorySeed,
      options
    );
  }

  /** Await all outstanding background writes (tests, graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Stop the cross-instance listener. Call on graceful shutdown. */
  stopRemoteSync(): void {
    this.unsubscribeRemote?.();
    this.unsubscribeRemote = undefined;
  }

  private persist(operation: string, snapshot: SharedStateWithCatalogs): void {
    this.lastWrittenRevision = Math.max(
      this.lastWrittenRevision,
      snapshot.revision
    );
    const serialized = serializeStateForStorage(snapshot);
    const work = this.docRef
      .set(serialized as unknown as Record<string, unknown>)
      .then(() => undefined)
      .catch((error) => {
        this.onError?.(error, { operation });
      });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private startRemoteSync(): void {
    this.unsubscribeRemote = this.docRef.onSnapshot(
      (snapshot) => {
        if (!snapshot.exists) return;
        const data = snapshot.data();
        if (!isSerializedSharedState(data)) return;
        // Ignore our own writes and any stale/older revision.
        if (data.revision <= this.getRevision()) return;
        if (data.revision <= this.lastWrittenRevision) return;

        const remoteState = deserializeStateFromStorage(data);
        this.lastWrittenRevision = remoteState.revision;
        // Adopt the remote snapshot as-is (its revision is authoritative) and
        // notify local subscribers so SSE fans out to this instance's clients.
        this.adoptRemoteState(remoteState);
      },
      (error) => {
        this.onError?.(error, { operation: 'onSnapshot' });
      }
    );
  }

  /** Apply a snapshot produced by another instance without re-incrementing. */
  private adoptRemoteState(remoteState: SharedStateWithCatalogs): void {
    // applyCommittedState (protected on the base class) replaces state and
    // notifies subscribers using the snapshot's own revision.
    (this as unknown as {
      applyCommittedState: (s: SharedStateWithCatalogs) => void;
    }).applyCommittedState(deepClone(remoteState));
  }
}

export interface DurableRepositoryBundle {
  repository: FirestoreStateRepository;
  ledger?: InvocationLedger;
}
