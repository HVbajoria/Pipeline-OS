import type { Firestore } from 'firebase-admin/firestore';
import type { ActivityLogEntry, ActorType } from '../../shared/models';
import type { AuthorizationRole, TrustedPrincipal } from '../authorization';

const DEFAULT_COLLECTION = 'users';
const DEFAULT_ACTIONS_SUBCOLLECTION = 'actions';

export interface UserIdentity {
  subject: string;
  tenantId: string;
  actorType: ActorType;
  roles: readonly AuthorizationRole[];
  displayName?: string;
  email?: string;
  source?: string;
  policyVersion?: string;
}

export interface UserActivityStore {
  upsertIdentity(identity: UserIdentity): void | Promise<void>;
  recordActivity(
    activity: ActivityLogEntry,
    principal?: TrustedPrincipal
  ): void | Promise<void>;
  flush(): Promise<void>;
}

interface FirestoreUserStoreOptions {
  firestore: Firestore;
  collectionName?: string;
  actionsSubcollection?: string;
  onError?: (error: unknown, context: { operation: string }) => void;
}

interface UserDocument {
  userId: string;
  subject: string;
  tenantId: string;
  actorType: ActorType;
  roles: readonly AuthorizationRole[];
  role?: AuthorizationRole;
  displayName?: string;
  name?: string;
  email?: string;
  source?: string;
  policyVersion?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  lastActionAt?: string;
  lastAction?: string;
}

interface UserActionDocument {
  id: string;
  userId: string;
  tenantId: string;
  operation: string;
  actorType: ActorType;
  phase?: string;
  timestamp: string;
  outcome: 'success' | 'error' | 'replayed';
  errorCode?: string;
  replayed?: boolean;
  originalActivityId?: string;
  approvalId?: string;
  correlationId?: string;
  traceId?: string;
}

function documentId(tenantId: string, subject: string): string {
  return encodeURIComponent(`${tenantId}::${subject}`);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function errorCodeFromActivity(activity: ActivityLogEntry): string | undefined {
  const output = activity.output as Record<string, unknown>;
  const error = output.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function identityFromPrincipal(principal: TrustedPrincipal): UserIdentity {
  return {
    subject: principal.actor.actorId,
    tenantId: principal.tenantId ?? 'pipelineos-demo',
    actorType: principal.actor.actorType,
    roles: principal.roles,
    ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }),
    ...(principal.email === undefined ? {} : { email: principal.email }),
    source: principal.source,
    policyVersion: principal.policyVersion
  };
}

/**
 * Best-effort Firestore projection for authenticated users and their actions.
 * Pipeline state and its redacted activity log remain authoritative; this
 * collection is a queryable user/profile view with idempotent action records.
 */
export class FirestoreUserStore implements UserActivityStore {
  private readonly firestore: Firestore;
  private readonly collectionName: string;
  private readonly actionsSubcollection: string;
  private readonly onError?: FirestoreUserStoreOptions['onError'];
  private readonly pending = new Set<Promise<void>>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FirestoreUserStoreOptions) {
    this.firestore = options.firestore;
    this.collectionName = options.collectionName ?? DEFAULT_COLLECTION;
    this.actionsSubcollection =
      options.actionsSubcollection ?? DEFAULT_ACTIONS_SUBCOLLECTION;
    this.onError = options.onError;
    const initialization = this.enqueue(async () => {
      await this.firestore
        .collection(this.collectionName)
        .doc('__collection__')
        .set({
          kind: 'pipelineos_user_collection',
          updatedAt: new Date().toISOString()
        }, { merge: true });
    }, 'initialize');
    void initialization;
  }

  upsertIdentity(identity: UserIdentity): void {
    const work = this.enqueue(async () => {
      const now = new Date().toISOString();
      const userRef = this.userReference(identity.tenantId, identity.subject);
      const existing = await userRef.get();
      const existingData = existing.exists
        ? (existing.data() as Partial<UserDocument> | undefined)
        : undefined;
      const displayName = nonEmpty(identity.displayName);
      const email = nonEmpty(identity.email);
      const document: UserDocument = {
        userId: identity.subject,
        subject: identity.subject,
        tenantId: identity.tenantId,
        actorType: identity.actorType,
        roles: [...new Set(identity.roles)],
        ...(identity.roles[0] === undefined ? {} : { role: identity.roles[0] }),
        ...(displayName === undefined ? {} : { displayName, name: displayName }),
        ...(email === undefined ? {} : { email }),
        ...(identity.source === undefined ? {} : { source: identity.source }),
        ...(identity.policyVersion === undefined
          ? {}
          : { policyVersion: identity.policyVersion }),
        createdAt: existingData?.createdAt ?? now,
        updatedAt: now,
        lastSeenAt: now,
        ...(existingData?.lastActionAt === undefined
          ? {}
          : { lastActionAt: existingData.lastActionAt }),
        ...(existingData?.lastAction === undefined
          ? {}
          : { lastAction: existingData.lastAction })
      };
      await userRef.set(document as unknown as Record<string, unknown>, { merge: true });
    }, 'upsert-identity');
    void work;
  }

  recordActivity(activity: ActivityLogEntry, principal?: TrustedPrincipal): void {
    const identity: UserIdentity = principal === undefined
      ? {
          subject: activity.actorId,
          tenantId: 'pipelineos-demo',
          actorType: activity.actorType,
          roles: []
        }
      : identityFromPrincipal(principal);
    const errorCode = errorCodeFromActivity(activity);
    const outcome = activity.replayed === true
      ? 'replayed'
      : errorCode === undefined
        ? 'success'
        : 'error';
    const work = this.enqueue(async () => {
      const now = new Date().toISOString();
      const userRef = this.userReference(identity.tenantId, identity.subject);
      const existing = await userRef.get();
      const existingData = existing.exists
        ? (existing.data() as Partial<UserDocument> | undefined)
        : undefined;
      const displayName = nonEmpty(identity.displayName);
      const email = nonEmpty(identity.email);
      const userDocument: UserDocument = {
        userId: identity.subject,
        subject: identity.subject,
        tenantId: identity.tenantId,
        actorType: identity.actorType,
        roles: [...new Set(identity.roles)],
        ...(identity.roles[0] === undefined ? {} : { role: identity.roles[0] }),
        ...(displayName === undefined ? {} : { displayName, name: displayName }),
        ...(email === undefined ? {} : { email }),
        ...(identity.source === undefined ? {} : { source: identity.source }),
        ...(identity.policyVersion === undefined
          ? {}
          : { policyVersion: identity.policyVersion }),
        createdAt: existingData?.createdAt ?? now,
        updatedAt: now,
        lastSeenAt: activity.timestamp,
        lastActionAt: activity.timestamp,
        lastAction: activity.toolName
      };
      await userRef.set(userDocument as unknown as Record<string, unknown>, { merge: true });

      const action: UserActionDocument = {
        id: activity.id,
        userId: identity.subject,
        tenantId: identity.tenantId,
        operation: activity.toolName,
        actorType: activity.actorType,
        ...(activity.phase === undefined ? {} : { phase: activity.phase }),
        timestamp: activity.timestamp,
        outcome,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(activity.replayed === true ? { replayed: true } : {}),
        ...(activity.originalActivityId === undefined
          ? {}
          : { originalActivityId: activity.originalActivityId }),
        ...(activity.approvalId === undefined ? {} : { approvalId: activity.approvalId }),
        ...(activity.correlationId === undefined ? {} : { correlationId: activity.correlationId }),
        ...(activity.traceId === undefined ? {} : { traceId: activity.traceId })
      };
      await userRef
        .collection(this.actionsSubcollection)
        .doc(activity.id)
        .set(action as unknown as Record<string, unknown>, { merge: true });
    }, 'record-activity');
    void work;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private userReference(tenantId: string, subject: string) {
    return this.firestore
      .collection(this.collectionName)
      .doc(documentId(tenantId, subject));
  }

  private enqueue(work: () => Promise<void>, operation: string): Promise<void> {
    const next = this.writeQueue.then(work, work).catch((error) => {
      this.onError?.(error, { operation });
    });
    this.writeQueue = next;
    this.pending.add(next);
    void next.finally(() => this.pending.delete(next));
    return next;
  }
}
