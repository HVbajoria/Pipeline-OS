import { ValidationError } from './errors';
import type { Timestamp } from './models';

/** Public-prospect source values are intentionally narrow and JSON-safe. */
export const GITHUB_PROSPECT_SOURCE = 'github' as const;
export const GITHUB_PROSPECT_DATA_ORIGIN = 'public_github' as const;
export const GITHUB_PROSPECT_CONSENT_STATUS = 'not_provided' as const;

export const GITHUB_PROSPECT_QUERY_MAX_LENGTH = 100;
export const GITHUB_PROSPECT_FILTER_MAX_LENGTH = 60;
/** JSON-schema-compatible pattern rejecting ASCII control characters. */
export const GITHUB_PROSPECT_SAFE_TEXT_PATTERN =
  '^[^\\u0000-\\u001F\\u007F]*$';

export interface GitHubProspectSearchInput {
  query: string;
  language?: string;
  location?: string;
}

export type NormalizedGitHubProspectSearchInput = GitHubProspectSearchInput;

/**
 * Allowlisted public GitHub profile projection. Private contact, resume, and
 * authentication data are deliberately absent from this isomorphic contract.
 */
export interface GitHubProspect {
  source: typeof GITHUB_PROSPECT_SOURCE;
  sourceUrl: string;
  profileUrl: string;
  username: string;
  login: string;
  avatarUrl?: string;
  profileType: string;
  searchScore: number;
  query: string;
  fetchedAt: Timestamp;
  dataOrigin: typeof GITHUB_PROSPECT_DATA_ORIGIN;
  consentStatus: typeof GITHUB_PROSPECT_CONSENT_STATUS;
  location?: string;
  bio?: string;
  publicRepos?: number;
}

export interface GitHubProspectCacheMetadata {
  hit: boolean;
  coalesced: boolean;
  ageMs: number;
  ttlMs: number;
  fetchedAt: Timestamp;
  expiresAt: Timestamp;
}

export interface GitHubProspectAttribution {
  source: typeof GITHUB_PROSPECT_SOURCE;
  apiUrl: string;
  searchApiDocsUrl: string;
  rateLimitsDocsUrl: string;
  userApiDocsUrl: string;
}

export interface GitHubProspectSearchResult {
  prospects: GitHubProspect[];
  /** The exact GitHub `q` expression used for this search. */
  query: string;
  filters: NormalizedGitHubProspectSearchInput;
  source: typeof GITHUB_PROSPECT_SOURCE;
  fetchedAt: Timestamp;
  cache: GitHubProspectCacheMetadata;
  attribution: GitHubProspectAttribution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedText(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, { field });
  }
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ValidationError(`${field} contains unsupported control characters`, {
      field
    });
  }
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0) {
    if (required) {
      throw new ValidationError(`${field} must not be empty`, { field });
    }
    return undefined;
  }
  if (normalized.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters`, {
      field
    });
  }
  return normalized;
}

/**
 * Normalize and validate the operation's only user-controlled search fields.
 * This is shared with operation validation so the value reaching a server
 * handler is identical to the value described by the GitHub service contract.
 */
export function normalizeGitHubProspectSearchInput(
  input: unknown
): NormalizedGitHubProspectSearchInput {
  if (!isRecord(input)) {
    throw new ValidationError('GitHub prospect search input must be an object');
  }

  const extraField = Object.keys(input).find(
    (key) => !['query', 'language', 'location'].includes(key)
  );
  if (extraField !== undefined) {
    throw new ValidationError(
      `Unsupported GitHub prospect search field: ${extraField}`,
      { field: extraField }
    );
  }

  const query = normalizedText(
    input.query,
    'query',
    GITHUB_PROSPECT_QUERY_MAX_LENGTH,
    true
  )!;
  const language = normalizedText(
    input.language,
    'language',
    GITHUB_PROSPECT_FILTER_MAX_LENGTH,
    false
  );
  const location = normalizedText(
    input.location,
    'location',
    GITHUB_PROSPECT_FILTER_MAX_LENGTH,
    false
  );

  return {
    query,
    ...(language === undefined ? {} : { language }),
    ...(location === undefined ? {} : { location })
  };
}
