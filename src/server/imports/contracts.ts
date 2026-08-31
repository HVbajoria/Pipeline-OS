/**
 * Source-agnostic contracts for importing public job listings.
 *
 * These types describe the boundary between an approved source adapter and
 * PipelineOS. They deliberately do not depend on React, WebMCP, Express, or a
 * particular transport/database implementation.
 */

import type { Timestamp } from '../../shared/models';
import type { PipelineValidationIssue } from '../../shared/errors';

/** Optional compensation metadata attached to an employment description. */
export interface PublicCompensationRange {
  min: number;
  max: number;
  currency: string;
}

/** Optional employment facts that an approved source may provide. */
export interface EmploymentMetadata {
  employmentType?: string;
  workplaceType?: string;
  compensationRange?: PublicCompensationRange;
}

/**
 * Untrusted adapter output before normalization. The source name and fetch
 * timestamp may be supplied by the adapter context when the payload omits
 * them, but a normalized record always contains both values.
 */
export interface PublicJobListingInput {
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: readonly string[];
  sourceName?: string;
  canonicalSourceUrl: string;
  fetchedAt?: string;
  externalId?: string | null;
  employmentMetadata?: EmploymentMetadata | null;
}

/** Canonical, validated public listing retained by the importer boundary. */
export interface PublicJobListingRecord {
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: string[];
  sourceName: string;
  canonicalSourceUrl: string;
  fetchedAt: Timestamp;
  externalId?: string;
  employmentMetadata?: EmploymentMetadata;
}

export interface PublicJobListingNormalizationOptions {
  /** Adapter-owned attribution used when the payload omits sourceName. */
  sourceName?: string;
  /** Import-run timestamp used when the payload omits fetchedAt. */
  fetchedAt?: string;
}

/** Context supplied to an approved RSS/JSON/API adapter by the importer. */
export interface PublicJobListingAdapterContext {
  readonly fetchedAt: Timestamp;
  readonly signal?: AbortSignal;
}

/**
 * Future source adapters should only parse an approved public source and
 * return payloads in this shape. The importer never performs network access.
 */
export interface PublicJobListingSourceAdapter {
  readonly adapterName: string;
  readonly sourceName: string;
  /** Public feed endpoint used for source-level attribution and diagnostics. */
  readonly sourceUrl?: string;
  fetchListings(
    context: PublicJobListingAdapterContext
  ): Promise<readonly PublicJobListingInput[]>;
}

/** Injectable time source for deterministic import tests and scheduled jobs. */
export interface ImportClock {
  now(): Timestamp;
}

/**
 * Persistence boundary for normalized listings. A database-backed or
 * authorized webhook implementation can provide async methods later without
 * changing normalization, deduplication, or counting behavior.
 */
export interface PublicJobListingStore {
  findByDeduplicationKey(
    key: string
  ): PublicJobListingRecord | undefined | PromiseLike<PublicJobListingRecord | undefined>;
  upsertByDeduplicationKey(
    key: string,
    record: PublicJobListingRecord
  ): void | PromiseLike<void>;
  list():
    | readonly PublicJobListingRecord[]
    | PromiseLike<readonly PublicJobListingRecord[]>;
}

export type PublicJobImportErrorCode =
  | 'VALIDATION_ERROR'
  | 'ADAPTER_ERROR'
  | 'STORE_ERROR';

export interface PublicJobImportErrorDetails {
  index?: number;
  field?: string;
  issues?: readonly PipelineValidationIssue[];
  sourceName?: string;
  canonicalSourceUrl?: string;
  externalId?: string;
}

/** An actionable per-record or adapter/store failure. */
export interface PublicJobImportError {
  code: PublicJobImportErrorCode;
  message: string;
  details?: PublicJobImportErrorDetails;
}

/** Attribution retained on every import result. */
export interface PublicJobImportAttribution {
  adapterName: string;
  sourceName: string;
  importedAt: Timestamp;
  canonicalSourceUrls: string[];
}

/** Counts and attribution returned by one adapter import run. */
export interface PublicJobImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  errorDetails: PublicJobImportError[];
  attribution: PublicJobImportAttribution;
}

export interface PublicJobImportOptions {
  clock?: ImportClock;
  signal?: AbortSignal;
}
