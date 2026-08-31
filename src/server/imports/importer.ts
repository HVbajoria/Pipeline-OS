import {
  PipelineError,
  type PipelineValidationIssue
} from '../../shared/errors';
import { normalizeDate, normalizePublicJobListing } from './normalization';
import {
  arePublicJobListingsEqual,
  getPublicJobListingDeduplicationKey
} from './deduplication';
import type {
  ImportClock,
  PublicJobImportError,
  PublicJobImportErrorDetails,
  PublicJobImportOptions,
  PublicJobImportResult,
  PublicJobListingSourceAdapter,
  PublicJobListingStore
} from './contracts';

function defaultImportClock(): ImportClock {
  return {
    now: () => new Date().toISOString()
  };
}

function safeSourceText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function rawAttribution(
  raw: unknown,
  sourceName: string,
  index: number
): PublicJobImportErrorDetails {
  const details: PublicJobImportErrorDetails = { index, sourceName };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return details;
  }
  const value = raw as Record<string, unknown>;
  const rawSourceName = safeSourceText(value.sourceName);
  if (rawSourceName !== undefined) details.sourceName = rawSourceName;
  const rawUrl = safeSourceText(value.canonicalSourceUrl);
  if (rawUrl !== undefined) details.canonicalSourceUrl = rawUrl;
  const externalId = safeSourceText(value.externalId);
  if (externalId !== undefined) details.externalId = externalId;
  return details;
}

function issuesFromError(error: unknown, fallbackPath?: string): PipelineValidationIssue[] | undefined {
  const pipelineError = PipelineError.from(error);
  if (pipelineError.details?.issues !== undefined) {
    return [...pipelineError.details.issues];
  }
  if (fallbackPath !== undefined) {
    return [{ path: fallbackPath, message: pipelineError.message }];
  }
  return undefined;
}

function validationImportError(
  error: unknown,
  raw: unknown,
  sourceName: string,
  index: number
): PublicJobImportError {
  const pipelineError = PipelineError.from(error);
  const details = rawAttribution(raw, sourceName, index);
  const issues = issuesFromError(error, 'listing');
  if (pipelineError.details?.field !== undefined) {
    details.field = pipelineError.details.field;
  }
  if (issues !== undefined) details.issues = issues;
  return {
    code: 'VALIDATION_ERROR',
    message: pipelineError.message,
    details
  };
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return PipelineError.from(error).message;
}

function adapterImportError(
  error: unknown,
  sourceName: string
): PublicJobImportError {
  return {
    code: 'ADAPTER_ERROR',
    message: readableError(error),
    details: { sourceName }
  };
}

function storeImportError(
  error: unknown,
  sourceName: string,
  index: number,
  key: string
): PublicJobImportError {
  return {
    code: 'STORE_ERROR',
    message: `Could not persist public job listing (${key}): ${readableError(error)}`,
    details: { index, sourceName, field: 'store' }
  };
}

function initialResult(
  adapterName: string,
  sourceName: string,
  importedAt: string
): PublicJobImportResult {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
    attribution: {
      adapterName,
      sourceName,
      importedAt,
      canonicalSourceUrls: []
    }
  };
}

function addError(
  result: PublicJobImportResult,
  error: PublicJobImportError
): void {
  result.errors += 1;
  result.errorDetails.push(error);
}

/**
 * Import one approved adapter's listings. No network request is made here:
 * the adapter owns source access, while this function owns normalization,
 * deduplication, persistence, counters, and attribution.
 */
export async function importPublicJobListings(
  adapter: PublicJobListingSourceAdapter,
  store: PublicJobListingStore,
  options: PublicJobImportOptions = {}
): Promise<PublicJobImportResult> {
  const clock = options.clock ?? defaultImportClock();
  const adapterName = safeSourceText(adapter?.adapterName) ?? 'unknown-adapter';
  const sourceName = safeSourceText(adapter?.sourceName) ?? 'unknown-source';
  const importedAt = normalizeDate(clock.now(), 'importedAt');
  const result = initialResult(adapterName, sourceName, importedAt);

  if (adapterName === 'unknown-adapter' || sourceName === 'unknown-source') {
    addError(result, {
      code: 'ADAPTER_ERROR',
      message: 'Adapter name and source name must be non-empty',
      details: {
        sourceName: sourceName === 'unknown-source' ? undefined : sourceName,
        field: adapterName === 'unknown-adapter' ? 'adapterName' : 'sourceName'
      }
    });
    return result;
  }

  let rawListings: unknown;
  try {
    rawListings = await adapter.fetchListings({
      fetchedAt: importedAt,
      signal: options.signal
    });
  } catch (error) {
    addError(result, adapterImportError(error, sourceName));
    return result;
  }

  if (!Array.isArray(rawListings)) {
    addError(result, {
      code: 'ADAPTER_ERROR',
      message: 'Source adapter must return an array of public job listings',
      details: { sourceName, field: 'fetchListings' }
    });
    return result;
  }

  for (const [index, rawListing] of rawListings.entries()) {
    let normalized;
    try {
      normalized = normalizePublicJobListing(rawListing, {
        sourceName,
        fetchedAt: importedAt
      });
    } catch (error) {
      addError(result, validationImportError(error, rawListing, sourceName, index));
      continue;
    }

    if (!result.attribution.canonicalSourceUrls.includes(normalized.canonicalSourceUrl)) {
      result.attribution.canonicalSourceUrls.push(normalized.canonicalSourceUrl);
    }

    const key = getPublicJobListingDeduplicationKey(normalized);
    let existing;
    try {
      existing = await store.findByDeduplicationKey(key);
      if (existing === undefined) {
        await store.upsertByDeduplicationKey(key, normalized);
        result.created += 1;
      } else if (arePublicJobListingsEqual(existing, normalized)) {
        result.skipped += 1;
      } else {
        await store.upsertByDeduplicationKey(key, normalized);
        result.updated += 1;
      }
    } catch (error) {
      addError(result, storeImportError(error, sourceName, index, key));
    }
  }

  result.attribution.canonicalSourceUrls.sort();
  return result;
}

export const runPublicJobListingImport = importPublicJobListings;
