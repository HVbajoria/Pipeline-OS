/**
 * Firestore-backed web session store.
 *
 * The `WebSessionStore` interface (see `auth/webSession.ts`) already permits
 * async (`Promise`) returns, so this store is natively asynchronous: signed-in
 * browser sessions live in Firestore and therefore survive a process restart
 * and are shared across every server instance behind a load balancer.
 *
 * Expiry is enforced on read (an expired session is deleted and treated as
 * absent), matching `InMemoryWebSessionStore` semantics.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type {
  WebSession,
  WebSessionStore
} from '../auth/webSession';

export interface FirestoreWebSessionStoreOptions {
  firestore: Firestore;
  /** Firestore collection name. Defaults to `web_sessions`. */
  collectionName?: string;
}

const DEFAULT_COLLECTION = 'web_sessions';

function isWebSession(value: unknown): value is WebSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as WebSession).sessionId === 'string' &&
    typeof (value as WebSession).expiresAt === 'number' &&
    typeof (value as WebSession).claims === 'object'
  );
}

export class FirestoreWebSessionStore implements WebSessionStore {
  private readonly firestore: Firestore;
  private readonly collectionName: string;

  constructor(options: FirestoreWebSessionStoreOptions) {
    this.firestore = options.firestore;
    this.collectionName = options.collectionName ?? DEFAULT_COLLECTION;
  }

  async get(sessionId: string): Promise<WebSession | undefined> {
    const doc = await this.firestore
      .collection(this.collectionName)
      .doc(sessionId)
      .get();
    if (!doc.exists) return undefined;
    const data = doc.data();
    if (!isWebSession(data)) return undefined;
    if (data.expiresAt <= Date.now()) {
      // Fire-and-forget cleanup of the expired session document.
      await this.delete(sessionId).catch(() => undefined);
      return undefined;
    }
    return data;
  }

  async set(session: WebSession): Promise<void> {
    await this.firestore
      .collection(this.collectionName)
      .doc(session.sessionId)
      .set(session as unknown as Record<string, unknown>);
  }

  async delete(sessionId: string): Promise<void> {
    await this.firestore
      .collection(this.collectionName)
      .doc(sessionId)
      .delete();
  }
}
