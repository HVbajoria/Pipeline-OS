import type { PublicJobListingRecord } from './contracts';
import { normalizeWhitespace } from './normalization';

export type PublicJobListingDeduplicationStrategy =
  | 'source-external-id'
  | 'canonical-url'
  | 'company-title-location';

function keyText(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase('en-US');
}

/** Stable fallback identity from normalized company, title, and location. */
export function getPublicJobListingFallbackKey(
  record: Pick<PublicJobListingRecord, 'company' | 'title' | 'location'>
): string {
  return `company-title-location:${JSON.stringify([
    keyText(record.company),
    keyText(record.title),
    keyText(record.location)
  ])}`;
}

/** Return the precedence branch used for one normalized listing. */
export function getPublicJobListingDeduplicationStrategy(
  record: PublicJobListingRecord
): PublicJobListingDeduplicationStrategy {
  if (record.externalId !== undefined) return 'source-external-id';
  return record.canonicalSourceUrl.length > 0
    ? 'canonical-url'
    : 'company-title-location';
}

/**
 * Build a stable, collision-resistant key. External IDs are scoped to their
 * source; URL identity is used next; the final fallback intentionally uses
 * only normalized company, title, and location.
 */
export function getPublicJobListingDeduplicationKey(
  record: PublicJobListingRecord
): string {
  const strategy = getPublicJobListingDeduplicationStrategy(record);
  switch (strategy) {
    case 'source-external-id':
      return `${strategy}:${JSON.stringify([
        keyText(record.sourceName),
        keyText(record.externalId!)
      ])}`;
    case 'canonical-url':
      return `${strategy}:${JSON.stringify([record.canonicalSourceUrl])}`;
    case 'company-title-location':
      return getPublicJobListingFallbackKey(record);
  }
}

export interface PublicJobListingDeduplicationResult {
  records: PublicJobListingRecord[];
  duplicateCount: number;
  duplicateKeys: string[];
}

/** Keep the first record for each key in deterministic input order. */
export function deduplicatePublicJobListings(
  records: readonly PublicJobListingRecord[]
): PublicJobListingDeduplicationResult {
  const seen = new Set<string>();
  const deduplicated: PublicJobListingRecord[] = [];
  const duplicateKeys: string[] = [];

  for (const record of records) {
    const key = getPublicJobListingDeduplicationKey(record);
    if (seen.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seen.add(key);
    deduplicated.push(record);
  }

  return {
    records: deduplicated,
    duplicateCount: duplicateKeys.length,
    duplicateKeys
  };
}

/** Compare normalized records without treating object identity as meaningful. */
export function arePublicJobListingsEqual(
  left: PublicJobListingRecord,
  right: PublicJobListingRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const getDeduplicationKey = getPublicJobListingDeduplicationKey;
export const deduplicateListings = deduplicatePublicJobListings;
export const getFallbackDeduplicationKey = getPublicJobListingFallbackKey;
