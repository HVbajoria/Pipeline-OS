import type {
  PublicJobListingRecord,
  PublicJobListingStore
} from './contracts';
import { getPublicJobListingDeduplicationKey } from './deduplication';

function cloneRecord(record: PublicJobListingRecord): PublicJobListingRecord {
  const clone: PublicJobListingRecord = {
    ...record,
    requirements: [...record.requirements]
  };
  if (record.externalId !== undefined) clone.externalId = record.externalId;
  if (record.employmentMetadata !== undefined) {
    clone.employmentMetadata = {
      ...record.employmentMetadata,
      ...(record.employmentMetadata.compensationRange === undefined
        ? {}
        : {
            compensationRange: {
              ...record.employmentMetadata.compensationRange
            }
          })
    };
  }
  return clone;
}

/**
 * Small deterministic store for demos/tests. Production integrations can
 * implement PublicJobListingStore with a database or queue-backed repository.
 */
export class InMemoryPublicJobListingStore implements PublicJobListingStore {
  private readonly recordsByKey = new Map<string, PublicJobListingRecord>();

  constructor(records: readonly PublicJobListingRecord[] = []) {
    for (const record of records) {
      this.recordsByKey.set(
        getPublicJobListingDeduplicationKey(record),
        cloneRecord(record)
      );
    }
  }

  findByDeduplicationKey(key: string): PublicJobListingRecord | undefined {
    const record = this.recordsByKey.get(key);
    return record === undefined ? undefined : cloneRecord(record);
  }

  upsertByDeduplicationKey(
    key: string,
    record: PublicJobListingRecord
  ): void {
    this.recordsByKey.set(key, cloneRecord(record));
  }

  list(): readonly PublicJobListingRecord[] {
    return [...this.recordsByKey.values()].map(cloneRecord);
  }
}

export const InMemoryPublicJobListingRepository = InMemoryPublicJobListingStore;
