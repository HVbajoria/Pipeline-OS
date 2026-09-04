/**
 * Durable persistence composition for PipelineOS.
 *
 * This barrel assembles the four Firestore-backed stores that replace the
 * in-memory demo seams:
 *   - `FirestoreStateRepository` for the authoritative Shared_State.
 *   - `FirestoreInvocationLedger` for idempotency keys.
 *   - `FirestoreWebSessionStore` for browser sessions.
 *   - `FirestoreUserStore` for tenant-scoped user profiles and action records.
 *
 * A composition root calls `createDurablePersistence()` and injects the
 * returned stores into the API/service. When Firestore is not configured, the
 * caller keeps the existing in-memory defaults.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  firestoreCredentialsAvailable,
  getFirestore,
  type FirestoreBootstrapOptions
} from './firestore';
import { FirestoreInvocationLedger } from './firestoreInvocationLedger';
import {
  FirestoreStateRepository,
  type FirestoreStateRepositoryOptions
} from './firestoreStateRepository';
import { FirestoreWebSessionStore } from './firestoreWebSessionStore';
import { FirestoreUserStore } from './firestoreUserStore';
import type { WebSessionStore } from '../auth/webSession';

export * from './firestore';
export * from './stateSerialization';
export { FirestoreInvocationLedger } from './firestoreInvocationLedger';
export { FirestoreStateRepository } from './firestoreStateRepository';
export { FirestoreWebSessionStore } from './firestoreWebSessionStore';
export { FirestoreUserStore } from './firestoreUserStore';
export * from './firestoreNormalizedState';

export interface DurablePersistenceOptions extends FirestoreBootstrapOptions {
  /** Reuse an existing Firestore instance instead of bootstrapping one. */
  firestore?: Firestore;
  /** Adopt cross-instance revisions via onSnapshot. Default true. */
  crossInstanceSync?: boolean;
  /** Optional collection name overrides. */
  collections?: {
    state?: string;
    ledger?: string;
    sessions?: string;
    users?: string;
  };
  /** Tenant key used by normalized domain collections. */
  tenantId?: string;
  /** Prefix used by normalized domain collection names. */
  normalizedCollectionPrefix?: string;
  /** Disable normalized domain collections only for legacy migration hosts. */
  normalizedPersistence?: boolean;
  /** Reports background persistence failures. Defaults to console.error. */
  onError?: (error: unknown, context: { store: string; operation: string }) => void;
}

export interface DurablePersistence {
  firestore: Firestore;
  repository: FirestoreStateRepository;
  ledger: FirestoreInvocationLedger;
  sessionStore: FirestoreWebSessionStore;
  userStore: FirestoreUserStore;
}

/**
 * True when durable persistence can be initialized. Explicitly disabled with
 * `PERSISTENCE_BACKEND=memory`; otherwise it depends on Firestore credentials.
 */
export function durablePersistenceAvailable(
  options: FirestoreBootstrapOptions = {}
): boolean {
  const backend = process.env.PERSISTENCE_BACKEND?.toLowerCase();
  if (backend === 'memory') return false;
  if (backend === 'firestore') return true;
  return firestoreCredentialsAvailable(options);
}

/**
 * Bootstrap Firestore and build all durable stores, hydrating the repository
 * from the last persisted snapshot. The ledger is loaded from Firestore before
 * it is returned so idempotency survives a restart.
 */
export async function createDurablePersistence(
  options: DurablePersistenceOptions = {}
): Promise<DurablePersistence> {
  const firestore = options.firestore ?? getFirestore(options);
  const onError = options.onError;

  const ledger = new FirestoreInvocationLedger({
    firestore,
    ...(options.collections?.ledger === undefined
      ? {}
      : { collectionName: options.collections.ledger }),
    onError: (error, context) =>
      onError?.(error, { store: 'ledger', operation: context.operation })
  });
  await ledger.load();

  const repositoryOptions: FirestoreStateRepositoryOptions = {
    firestore,
    invocationLedger: ledger,
    ...(options.collections?.state === undefined
      ? {}
      : { collectionName: options.collections.state }),
    ...(options.crossInstanceSync === undefined
      ? {}
      : { crossInstanceSync: options.crossInstanceSync }),
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.normalizedCollectionPrefix === undefined
      ? {}
      : { normalizedCollectionPrefix: options.normalizedCollectionPrefix }),
    ...(options.normalizedPersistence === undefined
      ? {}
      : { normalizedPersistence: options.normalizedPersistence }),
    onError: (error, context) =>
      onError?.(error, { store: 'repository', operation: context.operation })
  };
  const repository = await FirestoreStateRepository.create(repositoryOptions);

  const sessionStore: WebSessionStore & FirestoreWebSessionStore =
    new FirestoreWebSessionStore({
      firestore,
      ...(options.collections?.sessions === undefined
        ? {}
        : { collectionName: options.collections.sessions })
    });

  const userStore = new FirestoreUserStore({
    firestore,
    ...(options.collections?.users === undefined
      ? {}
      : { collectionName: options.collections.users }),
    onError: (error, context) =>
      onError?.(error, { store: 'users', operation: context.operation })
  });

  return { firestore, repository, ledger, sessionStore, userStore };
}
