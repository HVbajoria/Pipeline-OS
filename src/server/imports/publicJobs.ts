import { normalizeDate, normalizePublicJobListing } from './normalization';
import { deduplicatePublicJobListings } from './deduplication';
import type {
  PublicJobListingRecord,
  PublicJobListingSourceAdapter
} from './contracts';
import {
  ArbeitnowPublicJobListingAdapter,
  JobicyPublicJobListingAdapter,
  type PublicJobSourceFetch
} from './sources';
import { PublicJobListingAdapterError } from './sources/shared';
import type { Timestamp } from '../../shared/models';

export const DEFAULT_PUBLIC_JOBS_CACHE_TTL_MS = 15 * 60 * 1000;

export interface PublicJobsClock {
  now(): Timestamp;
}

export type PublicJobsSourceStatus = 'fresh' | 'cached' | 'stale' | 'error';

export interface PublicJobsSourceMetadata {
  adapterName: string;
  sourceName: string;
  sourceUrl: string;
  listingCount: number;
  fetchedAt: Timestamp | null;
  cached: boolean;
  status: PublicJobsSourceStatus;
  canonicalSourceUrls: string[];
}

export type PublicJobsSourceErrorCode =
  | 'FETCH_ERROR'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'MALFORMED_PAYLOAD'
  | 'MALFORMED_LISTING'
  | 'ADAPTER_ERROR';

export interface PublicJobsSourceError {
  adapterName: string;
  sourceName: string;
  sourceUrl: string;
  code: PublicJobsSourceErrorCode;
  message: string;
  occurredAt: Timestamp;
}

export type PublicJobsCacheState =
  | 'fresh'
  | 'refreshed'
  | 'stale'
  | 'partial'
  | 'empty';

export interface PublicJobsCacheMetadata {
  state: PublicJobsCacheState;
  ttlMs: number;
  requestedAt: Timestamp;
  fetchedAt: Timestamp | null;
  expiresAt: Timestamp | null;
  hit: boolean;
  refreshed: boolean;
}

export interface PublicJobsResult {
  listings: PublicJobListingRecord[];
  fetchedAt: Timestamp | null;
  cache: PublicJobsCacheMetadata;
  sources: PublicJobsSourceMetadata[];
  errors: PublicJobsSourceError[];
}

export interface PublicJobsRequestOptions {
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface PublicJobsCoordinatorOptions {
  adapters?: readonly PublicJobListingSourceAdapter[];
  fetcher?: PublicJobSourceFetch;
  clock?: PublicJobsClock;
  cacheTtlMs?: number;
}

interface CacheEntry {
  listings: PublicJobListingRecord[];
  fetchedAt: Timestamp;
  expiresAtMs: number;
}

function defaultClock(): PublicJobsClock {
  return { now: () => new Date().toISOString() };
}

function cloneListing(listing: PublicJobListingRecord): PublicJobListingRecord {
  return {
    ...listing,
    requirements: [...listing.requirements],
    ...(listing.employmentMetadata === undefined
      ? {}
      : {
          employmentMetadata: {
            ...listing.employmentMetadata,
            ...(listing.employmentMetadata.compensationRange === undefined
              ? {}
              : {
                  compensationRange: {
                    ...listing.employmentMetadata.compensationRange
                  }
                })
          }
        })
  };
}

function cloneListings(
  listings: readonly PublicJobListingRecord[]
): PublicJobListingRecord[] {
  return listings.map(cloneListing);
}

function adapterSourceUrl(adapter: PublicJobListingSourceAdapter): string {
  return typeof adapter.sourceUrl === 'string' ? adapter.sourceUrl : '';
}

function sourceErrorCode(error: unknown): PublicJobsSourceErrorCode {
  if (error instanceof PublicJobListingAdapterError) return error.code;
  return 'ADAPTER_ERROR';
}

function sourceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Public job source adapter failed';
}

function maxTimestamp(
  timestamps: readonly (Timestamp | null)[]
): Timestamp | null {
  const valid = timestamps.filter((timestamp): timestamp is Timestamp =>
    timestamp !== null
  );
  if (valid.length === 0) return null;
  return valid.reduce((latest, timestamp) =>
    Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest
  );
}

function minExpiry(
  entries: readonly (CacheEntry | undefined)[]
): Timestamp | null {
  const expiries = entries
    .filter((entry): entry is CacheEntry => entry !== undefined)
    .map((entry) => entry.expiresAtMs)
    .filter((value) => Number.isFinite(value));
  if (expiries.length === 0) return null;
  return new Date(Math.min(...expiries)).toISOString();
}

/**
 * Coordinates the approved public feeds without touching SharedStateRepository.
 * Each source has an independent cache entry, so a failure in one feed does
 * not discard successful or previously cached listings from the other feed.
 */
export interface PublicJobsService {
  getListings(options?: PublicJobsRequestOptions): Promise<PublicJobsResult>;
}

export class PublicJobsCoordinator implements PublicJobsService {
  readonly cacheTtlMs: number;
  readonly adapters: readonly PublicJobListingSourceAdapter[];

  private readonly clock: PublicJobsClock;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: PublicJobsCoordinatorOptions = {}) {
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PUBLIC_JOBS_CACHE_TTL_MS;
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
      throw new Error('Public jobs cache TTL must be a positive finite number');
    }
    this.cacheTtlMs = cacheTtlMs;
    this.clock = options.clock ?? defaultClock();
    this.adapters = options.adapters ?? [
      new JobicyPublicJobListingAdapter({ fetcher: options.fetcher }),
      new ArbeitnowPublicJobListingAdapter({ fetcher: options.fetcher })
    ];
    if (this.adapters.length === 0) {
      throw new Error('Public jobs coordinator requires at least one source adapter');
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getListings(
    options: PublicJobsRequestOptions = {}
  ): Promise<PublicJobsResult> {
    const requestedAt = normalizeDate(this.clock.now(), 'requestedAt');
    const requestedAtMs = Date.parse(requestedAt);
    const refresh = options.refresh === true;
    const listings: PublicJobListingRecord[] = [];
    const sources: PublicJobsSourceMetadata[] = [];
    const errors: PublicJobsSourceError[] = [];
    const cacheEntries: Array<CacheEntry | undefined> = [];
    let refreshed = false;
    let cacheHit = false;

    // Intentionally sequential: the approved sources are polled conservatively.
    for (const adapter of this.adapters) {
      const key = adapter.adapterName;
      const existing = this.cache.get(key);
      cacheEntries.push(existing);
      const sourceUrl = adapterSourceUrl(adapter);
      const canUseCache = !refresh &&
        existing !== undefined &&
        requestedAtMs < existing.expiresAtMs;

      if (canUseCache) {
        cacheHit = true;
        const cachedListings = cloneListings(existing.listings);
        listings.push(...cachedListings);
        sources.push({
          adapterName: adapter.adapterName,
          sourceName: adapter.sourceName,
          sourceUrl,
          listingCount: cachedListings.length,
          fetchedAt: existing.fetchedAt,
          cached: true,
          status: 'cached',
          canonicalSourceUrls: cachedListings
            .map((listing) => listing.canonicalSourceUrl)
            .sort()
        });
        continue;
      }

      refreshed = true;
      try {
        const rawListings = await adapter.fetchListings({
          fetchedAt: requestedAt,
          signal: options.signal
        });
        if (!Array.isArray(rawListings)) {
          throw new PublicJobListingAdapterError(
            'MALFORMED_PAYLOAD',
            'Source adapter must return an array of public job listings'
          );
        }
        const normalized = rawListings.map((rawListing) =>
          normalizePublicJobListing(rawListing, {
            sourceName: adapter.sourceName,
            fetchedAt: requestedAt
          })
        );
        const entry: CacheEntry = {
          listings: cloneListings(normalized),
          fetchedAt: requestedAt,
          expiresAtMs: requestedAtMs + this.cacheTtlMs
        };
        this.cache.set(key, entry);
        cacheEntries[cacheEntries.length - 1] = entry;
        listings.push(...cloneListings(normalized));
        sources.push({
          adapterName: adapter.adapterName,
          sourceName: adapter.sourceName,
          sourceUrl,
          listingCount: normalized.length,
          fetchedAt: requestedAt,
          cached: false,
          status: 'fresh',
          canonicalSourceUrls: normalized
            .map((listing) => listing.canonicalSourceUrl)
            .sort()
        });
      } catch (error) {
        const staleListings = existing === undefined
          ? []
          : cloneListings(existing.listings);
        listings.push(...staleListings);
        errors.push({
          adapterName: adapter.adapterName,
          sourceName: adapter.sourceName,
          sourceUrl,
          code: sourceErrorCode(error),
          message: sourceErrorMessage(error),
          occurredAt: requestedAt
        });
        sources.push({
          adapterName: adapter.adapterName,
          sourceName: adapter.sourceName,
          sourceUrl,
          listingCount: staleListings.length,
          fetchedAt: existing?.fetchedAt ?? null,
          cached: existing !== undefined,
          status: existing === undefined ? 'error' : 'stale',
          canonicalSourceUrls: staleListings
            .map((listing) => listing.canonicalSourceUrl)
            .sort()
        });
      }
    }

    const deduplicated = deduplicatePublicJobListings(listings).records;
    const sourceFetchedAt = maxTimestamp(
      sources.map((source) => source.fetchedAt)
    );
    const hasStaleOrError = sources.some(
      (source) => source.status === 'stale' || source.status === 'error'
    );
    const allUsedFreshCache = sources.every((source) => source.status === 'cached');
    const cacheState: PublicJobsCacheState = errors.length === 0
      ? (allUsedFreshCache ? 'fresh' : 'refreshed')
      : deduplicated.length > 0
        ? (hasStaleOrError && sources.some((source) => source.status === 'fresh')
          ? 'partial'
          : 'stale')
        : 'empty';

    return {
      listings: cloneListings(deduplicated),
      fetchedAt: sourceFetchedAt,
      cache: {
        state: cacheState,
        ttlMs: this.cacheTtlMs,
        requestedAt,
        fetchedAt: sourceFetchedAt,
        expiresAt: minExpiry(cacheEntries),
        hit: cacheHit,
        refreshed
      },
      sources,
      errors
    };
  }

  fetchListings = this.getListings.bind(this);
}

export const LivePublicJobsCoordinator = PublicJobsCoordinator;
export const createPublicJobsCoordinator = (
  options: PublicJobsCoordinatorOptions = {}
): PublicJobsCoordinator => new PublicJobsCoordinator(options);
