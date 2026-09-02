import { ValidationError } from './errors';
import type {
  ActorContext,
  CandidateId,
  SourcedProspectId,
  Timestamp
} from './models';

/** Public-prospect source values are intentionally narrow and JSON-safe. */
export const GITHUB_PROSPECT_SOURCE = 'github' as const;
export const GITHUB_PROSPECT_DATA_ORIGIN = 'public_github' as const;
export const GITHUB_PROSPECT_CONSENT_STATUS = 'not_provided' as const;
/** Shared default used by the demo UI and the default authorization policy. */
export const PUBLIC_PROSPECT_CONSENT_POLICY_VERSION = 'p11.2.v1' as const;
export const PUBLIC_PROSPECT_DEFAULT_CONSENT_SCOPE = 'candidate-profile-import' as const;

export const PUBLIC_PROSPECT_CONSENT_STATUSES = [
  'not_provided',
  'explicit',
  'withdrawn',
  'expired'
] as const;
export type PublicProspectConsentStatus =
  (typeof PUBLIC_PROSPECT_CONSENT_STATUSES)[number];

export const PUBLIC_PROSPECT_CONSENT_METHODS = [
  'candidate_submitted',
  'approved_consent_channel'
] as const;
export type PublicProspectConsentMethod =
  (typeof PUBLIC_PROSPECT_CONSENT_METHODS)[number];

export const PUBLIC_PROSPECT_FIELD_ORIGINS = [
  'github_public',
  'candidate_submitted',
  'recruiter_entered'
] as const;
export type PublicProspectFieldOrigin =
  (typeof PUBLIC_PROSPECT_FIELD_ORIGINS)[number];

export const PUBLIC_PROSPECT_CANDIDATE_LINK_ORIGINS = [
  'created_from_candidate_submitted',
  'preexisting_candidate'
] as const;
export type PublicProspectCandidateLinkOrigin =
  (typeof PUBLIC_PROSPECT_CANDIDATE_LINK_ORIGINS)[number];

export const PUBLIC_PROSPECT_SOURCE_RECORD_MAX_LENGTH = 100;
export const PUBLIC_PROSPECT_URL_MAX_LENGTH = 2048;
export const PUBLIC_PROSPECT_SCOPE_MAX_LENGTH = 200;
export const PUBLIC_PROSPECT_EVIDENCE_REFERENCE_MAX_LENGTH = 256;
export const PUBLIC_PROSPECT_POLICY_VERSION_MAX_LENGTH = 80;
export const PUBLIC_PROSPECT_FIELD_NAME_MAX_LENGTH = 100;
export const PUBLIC_PROSPECT_MAX_FIELD_ORIGINS = 32;

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

export interface PublicProspectSourceFilters {
  language?: string;
  location?: string;
}

export interface PublicProspectSourceReference {
  source: typeof GITHUB_PROSPECT_SOURCE;
  sourceRecordId: string;
  profileUrl: string;
  canonicalSourceUrl: string;
  sourceQuery: string;
  sourceFilters?: PublicProspectSourceFilters;
  fetchedAt: Timestamp;
  attribution: GitHubProspectAttribution;
}

/** Safe consent metadata; evidence contents remain server-private. */
export interface PublicProspectConsent {
  method: PublicProspectConsentMethod;
  scope: string;
  capturedAt: Timestamp;
  capturedBy: ActorContext;
  evidenceRef: string;
  policyVersion: string;
}

/** Candidate-supplied values are kept separate from public-source fields. */
export interface CandidateSubmittedProfile {
  name: string;
  email: string;
  resumeText: string;
  skills?: string[];
  experienceYears?: number;
}

export interface SourcedProspectRecord {
  id: SourcedProspectId;
  source: typeof GITHUB_PROSPECT_SOURCE;
  sourceRecordId: string;
  profileUrl: string;
  canonicalSourceUrl: string;
  sourceQuery: string;
  sourceFilters?: PublicProspectSourceFilters;
  fetchedAt: Timestamp;
  importedAt: Timestamp;
  dataOrigin: typeof GITHUB_PROSPECT_DATA_ORIGIN;
  consentStatus: PublicProspectConsentStatus;
  consent: PublicProspectConsent | null;
  fieldOrigins: Record<string, PublicProspectFieldOrigin>;
  attribution: GitHubProspectAttribution;
  retentionExpiresAt: Timestamp;
  /** Set by the canonical revoke path and retained as a safe lifecycle marker. */
  withdrawnAt?: Timestamp;
  /** Set by an explicit retention cleanup hook when the retention window ends. */
  expiredAt?: Timestamp;
  /** Distinguishes a candidate created by this consent from a preexisting record. */
  candidateLinkOrigin?: PublicProspectCandidateLinkOrigin;
  candidateId?: CandidateId;
}

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
