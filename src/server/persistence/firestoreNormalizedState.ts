import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import type {
  SharedStateWithCatalogs,
  Timestamp
} from '../../shared/models';

const NORMALIZED_SCHEMA_VERSION = 1;
const MAX_BATCH_WRITES = 450;
const DEFAULT_PREFIX = 'pipelineos';
const DEFAULT_TENANT_ID = 'pipelineos-demo';

const MAP_COLLECTIONS = [
  'jobs',
  'candidates',
  'applications',
  'panels',
  'interviews',
  'scorecards',
  'offers',
  'onboardingTasks',
  'backgroundChecks',
  'benefitsEnrollments',
  'approvalCards',
  'sourcedProspects'
] as const;

type MapCollectionName = (typeof MAP_COLLECTIONS)[number];

type NormalizedCollectionName =
  | MapCollectionName
  | 'activityLog'
  | 'availability'
  | 'roleTemplates'
  | 'catalogs'
  | 'stateHead';

interface StoredEntry {
  tenantId: string;
  recordId: string;
  revision: number;
  position?: number;
  updatedAt: Timestamp;
  data: unknown;
}

interface StoredStateHead {
  tenantId: string;
  schemaVersion: number;
  revision: number;
  updatedAt: Timestamp;
  collections: string[];
}

export interface FirestoreNormalizedStateOptions {
  /** Tenant key derived from the verified server/auth configuration. */
  tenantId?: string;
  /** Prefix used for the top-level Firestore collections. */
  collectionPrefix?: string;
}

interface CollectionNames {
  [key: string]: string;
}

function normalizedOptions(
  options: FirestoreNormalizedStateOptions = {}
): { tenantId: string; prefix: string; collections: CollectionNames } {
  const tenantId =
    options.tenantId?.trim() ||
    process.env.PIPELINEOS_TENANT_ID?.trim() ||
    process.env.FIREBASE_DEFAULT_TENANT_ID?.trim() ||
    DEFAULT_TENANT_ID;
  const prefix = options.collectionPrefix?.trim() || DEFAULT_PREFIX;
  const collections: CollectionNames = {
    stateHead: `${prefix}_state_heads`,
    activityLog: `${prefix}_activity_log`,
    availability: `${prefix}_availability`,
    roleTemplates: `${prefix}_role_templates`,
    catalogs: `${prefix}_catalogs`
  };
  for (const name of MAP_COLLECTIONS) {
    collections[name] = `${prefix}_${name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}`;
  }
  return { tenantId, prefix, collections };
}

function documentId(recordId: string): string {
  return encodeURIComponent(recordId || '__empty__');
}

function tenantRecordDocumentId(tenantId: string, recordId: string): string {
  return documentId(`${tenantId}::${recordId || '__empty__'}`);
}

function recordIdFromDocument(id: string, data: Record<string, unknown>): string {
  return typeof data.recordId === 'string'
    ? data.recordId
    : decodeURIComponent(id);
}

function mapEntries(state: SharedStateWithCatalogs, name: MapCollectionName): Array<[string, unknown]> {
  const value = (state as unknown as Record<string, unknown>)[name];
  return value instanceof Map ? [...value.entries()] : [];
}

function storedEntry(
  tenantId: string,
  revision: number,
  updatedAt: Timestamp,
  recordId: string,
  data: unknown,
  position?: number
): StoredEntry {
  return {
    tenantId,
    recordId,
    revision,
    ...(position === undefined ? {} : { position }),
    updatedAt,
    data
  };
}

async function commitOperations(
  firestore: Firestore,
  operations: Array<(batch: WriteBatch) => void>
): Promise<void> {
  for (let offset = 0; offset < operations.length; offset += MAX_BATCH_WRITES) {
    const batch = firestore.batch();
    for (const operation of operations.slice(offset, offset + MAX_BATCH_WRITES)) {
      operation(batch);
    }
    await batch.commit();
  }
}

async function replaceCollection(
  firestore: Firestore,
  collectionName: string,
  tenantId: string,
  entries: readonly StoredEntry[]
): Promise<void> {
  const collection = firestore.collection(collectionName);
  const existing = await collection.get();
  const currentIds = new Set(
    entries.map((entry) => tenantRecordDocumentId(tenantId, entry.recordId))
  );
  const operations: Array<(batch: WriteBatch) => void> = [];

  for (const entry of entries) {
    const reference = collection.doc(tenantRecordDocumentId(tenantId, entry.recordId));
    operations.push((batch) => batch.set(reference, entry as unknown as Record<string, unknown>));
  }

  for (const doc of existing.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (data.tenantId === tenantId && !currentIds.has(doc.id)) {
      operations.push((batch) => batch.delete(doc.ref));
    }
  }

  await commitOperations(firestore, operations);
}

function readEntries(
  tenantId: string,
  docs: Array<{ id: string; data(): Record<string, unknown> }>
): StoredEntry[] {
  return docs.flatMap((doc) => {
    const data = doc.data();
    if (data.tenantId !== tenantId || typeof data.data === 'undefined') return [];
    return [{
      tenantId,
      recordId: recordIdFromDocument(doc.id, data),
      revision: typeof data.revision === 'number' ? data.revision : 0,
      ...(typeof data.position === 'number' ? { position: data.position } : {}),
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      data: data.data
    }];
  });
}

async function readCollection(
  firestore: Firestore,
  collectionName: string,
  tenantId: string
): Promise<StoredEntry[]> {
  const snapshot = await firestore.collection(collectionName).get();
  return readEntries(tenantId, snapshot.docs);
}

/**
 * Persist every map-backed domain collection as tenant-scoped Firestore
 * documents. The legacy snapshot remains the recovery/compatibility source,
 * while these collections provide queryable professional tables.
 */
export async function persistNormalizedState(
  firestore: Firestore,
  state: SharedStateWithCatalogs,
  options: FirestoreNormalizedStateOptions = {}
): Promise<void> {
  const { tenantId, collections } = normalizedOptions(options);
  const updatedAt = new Date().toISOString();
  const writes: Promise<void>[] = [];

  for (const name of MAP_COLLECTIONS) {
    writes.push(
      replaceCollection(
        firestore,
        collections[name],
        tenantId,
        mapEntries(state, name).map(([recordId, data]) =>
          storedEntry(tenantId, state.revision, updatedAt, String(recordId), data)
        )
      )
    );
  }

  writes.push(
    replaceCollection(
      firestore,
      collections.activityLog,
      tenantId,
      state.activityLog.map((entry, position) =>
        storedEntry(tenantId, state.revision, updatedAt, entry.id, entry, position)
      )
    ),
    replaceCollection(
      firestore,
      collections.availability,
      tenantId,
      [...state.catalogs.availabilityCalendar.entries()].map(
        ([interviewerId, freeSlots]) =>
          storedEntry(tenantId, state.revision, updatedAt, interviewerId, { interviewerId, freeSlots })
      )
    ),
    replaceCollection(
      firestore,
      collections.roleTemplates,
      tenantId,
      state.catalogs.roleTemplates.map((template, position) =>
        storedEntry(tenantId, state.revision, updatedAt, template.id, template, position)
      )
    )
  );

  const catalogReference = firestore
    .collection(collections.catalogs)
    .doc(tenantRecordDocumentId(tenantId, 'config'));
  writes.push(
    catalogReference.set({
      tenantId,
      recordId: 'config',
      revision: state.revision,
      updatedAt,
      data: {
        planCatalog: state.catalogs.planCatalog,
        startDate: state.catalogs.startDate
      }
    }).then(() => undefined)
  );

  await Promise.all(writes);
  await firestore.collection(collections.stateHead).doc(documentId(tenantId)).set({
    tenantId,
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    revision: state.revision,
    updatedAt,
    collections: [
      ...MAP_COLLECTIONS,
      'activityLog',
      'availability',
      'roleTemplates',
      'catalogs'
    ]
  } satisfies StoredStateHead);
}

/** Load a complete normalized tenant state, or undefined when not initialized. */
export async function loadNormalizedState(
  firestore: Firestore,
  options: FirestoreNormalizedStateOptions = {}
): Promise<SharedStateWithCatalogs | undefined> {
  const { tenantId, collections } = normalizedOptions(options);
  const headSnapshot = await firestore
    .collection(collections.stateHead)
    .doc(documentId(tenantId))
    .get();
  if (!headSnapshot.exists) return undefined;

  const head = headSnapshot.data() as unknown as Partial<StoredStateHead> | undefined;
  if (
    head?.tenantId !== tenantId ||
    typeof head.revision !== 'number' ||
    head.schemaVersion !== NORMALIZED_SCHEMA_VERSION
  ) {
    return undefined;
  }

  const [
    jobs,
    candidates,
    applications,
    panels,
    interviews,
    scorecards,
    offers,
    onboardingTasks,
    backgroundChecks,
    benefitsEnrollments,
    approvalCards,
    sourcedProspects,
    activityLog,
    availability,
    roleTemplates,
    catalogs
  ] = await Promise.all([
    ...MAP_COLLECTIONS.map((name) => readCollection(firestore, collections[name], tenantId)),
    readCollection(firestore, collections.activityLog, tenantId),
    readCollection(firestore, collections.availability, tenantId),
    readCollection(firestore, collections.roleTemplates, tenantId),
    readCollection(firestore, collections.catalogs, tenantId)
  ]);

  const config = catalogs.find((entry) => entry.recordId === 'config')?.data as
    | { planCatalog?: unknown; startDate?: unknown }
    | undefined;
  if (config === undefined || config.planCatalog === undefined) return undefined;

  const asMap = <T>(entries: readonly StoredEntry[]): Map<string, T> =>
    new Map(entries.map((entry) => [entry.recordId, entry.data as T]));
  const ordered = <T>(entries: readonly StoredEntry[]): T[] =>
    [...entries]
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
      .map((entry) => entry.data as T);

  return {
    revision: head.revision,
    jobs: asMap(jobs),
    candidates: asMap(candidates),
    applications: asMap(applications),
    panels: asMap(panels),
    interviews: asMap(interviews),
    scorecards: asMap(scorecards),
    offers: asMap(offers),
    onboardingTasks: asMap(onboardingTasks),
    backgroundChecks: asMap(backgroundChecks),
    benefitsEnrollments: asMap(benefitsEnrollments),
    approvalCards: asMap(approvalCards),
    sourcedProspects: asMap(sourcedProspects),
    activityLog: ordered(activityLog),
    catalogs: {
      availabilityCalendar: new Map(
        availability.map((entry) => {
          const value = entry.data as { interviewerId?: string; freeSlots?: Timestamp[] };
          return [value.interviewerId ?? entry.recordId, value.freeSlots ?? []];
        })
      ),
      roleTemplates: ordered(roleTemplates),
      planCatalog: config.planCatalog as SharedStateWithCatalogs['catalogs']['planCatalog'],
      startDate: config.startDate as SharedStateWithCatalogs['catalogs']['startDate']
    }
  };
}

export function normalizedCollectionNames(
  options: FirestoreNormalizedStateOptions = {}
): Record<NormalizedCollectionName, string> {
  const { collections } = normalizedOptions(options);
  return collections as Record<NormalizedCollectionName, string>;
}
