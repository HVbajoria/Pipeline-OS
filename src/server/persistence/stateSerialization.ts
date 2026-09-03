/**
 * JSON serialization for the Map-backed Shared_State so it can be stored in a
 * single Firestore document and rehydrated at startup.
 *
 * Firestore stores plain JSON, but `SharedStateWithCatalogs` holds domain
 * collections as `Map` instances (and `catalogs.availabilityCalendar` is a
 * Map too). We convert every Map to an array of `[key, value]` entries on the
 * way out and back into Maps on the way in, preserving the exact runtime shape
 * the repository and operation handlers expect.
 */

import type {
  SharedCatalogs,
  SharedStateWithCatalogs,
  Timestamp
} from '../../shared/models';

/** The Map-typed collection keys on SharedStateWithCatalogs. */
const MAP_COLLECTION_KEYS = [
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

type MapCollectionKey = (typeof MAP_COLLECTION_KEYS)[number];

/**
 * Maps are serialized as plain objects keyed by the record id rather than
 * arrays of `[key, value]` tuples. Firestore forbids directly nested arrays
 * (an array whose elements are arrays), so an object is both legal and the
 * natural document shape for keyed collections.
 */
type MapObject = Record<string, unknown>;

export interface SerializedSharedState {
  revision: number;
  activityLog: unknown[];
  collections: Record<MapCollectionKey, MapObject>;
  catalogs: {
    availabilityCalendar: Record<string, Timestamp[]>;
    roleTemplates: unknown;
    planCatalog: unknown;
    startDate: unknown;
  };
}

function mapToObject(value: unknown): MapObject {
  const result: MapObject = {};
  if (value instanceof Map) {
    for (const [key, entry] of value.entries()) {
      result[String(key)] = entry;
    }
  }
  return result;
}

function objectToMap<V>(source: unknown): Map<string, V> {
  const result = new Map<string, V>();
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as MapObject)) {
      result.set(key, value as V);
    }
  }
  return result;
}

/** Convert live Map-backed state into a Firestore-safe plain object. */
export function serializeStateForStorage(
  state: SharedStateWithCatalogs
): SerializedSharedState {
  const record = state as unknown as Record<string, unknown>;
  const collections = {} as Record<MapCollectionKey, MapObject>;
  for (const key of MAP_COLLECTION_KEYS) {
    collections[key] = mapToObject(record[key]);
  }

  return {
    revision: state.revision,
    activityLog: [...state.activityLog],
    collections,
    catalogs: {
      availabilityCalendar: mapToObject(
        state.catalogs.availabilityCalendar
      ) as Record<string, Timestamp[]>,
      roleTemplates: state.catalogs.roleTemplates,
      planCatalog: state.catalogs.planCatalog,
      startDate: state.catalogs.startDate
    }
  };
}

function deserializeCatalogs(
  serialized: SerializedSharedState['catalogs']
): SharedCatalogs {
  return {
    availabilityCalendar: objectToMap<Timestamp[]>(
      serialized.availabilityCalendar
    ),
    roleTemplates: (serialized.roleTemplates ?? []) as SharedCatalogs['roleTemplates'],
    planCatalog: serialized.planCatalog as SharedCatalogs['planCatalog'],
    startDate: serialized.startDate as SharedCatalogs['startDate']
  };
}

/** Rehydrate live Map-backed state from a Firestore-stored plain object. */
export function deserializeStateFromStorage(
  serialized: SerializedSharedState
): SharedStateWithCatalogs {
  const collections = serialized.collections ?? ({} as Record<MapCollectionKey, MapObject>);
  const state: Record<string, unknown> = {
    revision: typeof serialized.revision === 'number' ? serialized.revision : 0,
    activityLog: Array.isArray(serialized.activityLog)
      ? [...serialized.activityLog]
      : [],
    catalogs: deserializeCatalogs(
      serialized.catalogs ?? {
        availabilityCalendar: {},
        roleTemplates: [],
        planCatalog: { medical: [], dental: [], vision: [] },
        startDate: undefined
      }
    )
  };
  for (const key of MAP_COLLECTION_KEYS) {
    state[key] = objectToMap(collections[key]);
  }
  return state as unknown as SharedStateWithCatalogs;
}

/** True when a Firestore document looks like a serialized state snapshot. */
export function isSerializedSharedState(
  value: unknown
): value is SerializedSharedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SerializedSharedState).revision === 'number' &&
    typeof (value as SerializedSharedState).collections === 'object'
  );
}
