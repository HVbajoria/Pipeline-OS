/**
 * Deterministic public-prospect provenance and consent rules.
 *
 * This module only normalizes and evaluates values supplied to it. It does not
 * fetch source data, read a clock, mutate a record, or choose a retention
 * policy. Callers must provide boundary timestamps explicitly.
 */

import { ValidationError } from '../errors';
import type { ActorContext, Timestamp } from '../models';
import type {
  GitHubProspectAttribution,
  PublicProspectConsent,
  PublicProspectConsentMethod,
  PublicProspectConsentStatus,
  PublicProspectFieldOrigin,
  PublicProspectSourceFilters,
  PublicProspectSourceReference,
  SourcedProspectRecord
} from '../publicProspects';
import {
  GITHUB_PROSPECT_SOURCE,
  GITHUB_PROSPECT_DATA_ORIGIN,
  PUBLIC_PROSPECT_CONSENT_METHODS,
  PUBLIC_PROSPECT_CONSENT_STATUSES,
  PUBLIC_PROSPECT_EVIDENCE_REFERENCE_MAX_LENGTH,
  PUBLIC_PROSPECT_FIELD_ORIGINS,
  PUBLIC_PROSPECT_FIELD_NAME_MAX_LENGTH,
  GITHUB_PROSPECT_FILTER_MAX_LENGTH,
  PUBLIC_PROSPECT_MAX_FIELD_ORIGINS,
  PUBLIC_PROSPECT_POLICY_VERSION_MAX_LENGTH,
  GITHUB_PROSPECT_QUERY_MAX_LENGTH,
  PUBLIC_PROSPECT_SCOPE_MAX_LENGTH,
  PUBLIC_PROSPECT_SOURCE_RECORD_MAX_LENGTH,
  PUBLIC_PROSPECT_URL_MAX_LENGTH
} from '../publicProspects';

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/u;

const GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'docs.github.com'
]);

export type PublicProspectRetentionStatus = 'active' | 'expired' | 'invalid';

export type PublicProspectConsentDecisionReason =
  | 'allowed'
  | 'not_provided'
  | 'withdrawn'
  | 'expired'
  | 'retention_expired'
  | 'invalid_retention'
  | 'missing_consent'
  | 'invalid_consent'
  | 'scope_mismatch'
  | 'policy_mismatch'
  | 'captured_in_future';

export interface PublicProspectConsentCheckOptions {
  /** The comparison instant; this value is never obtained from the system clock. */
  now: Timestamp;
  /** When present, the consent must cover this exact normalized scope. */
  requiredScope?: string;
  /** When present, the consent must use this policy version. */
  policyVersion?: string;
}

export interface PublicProspectConsentEvaluation {
  allowed: boolean;
  /** The persisted status, except explicit consent past retention is effective expired. */
  status: PublicProspectConsentStatus;
  reason: PublicProspectConsentDecisionReason;
  consent: PublicProspectConsent | null;
}

export interface PublicProspectFieldOriginValidationOptions {
  /** Require these retained field names to have an origin. */
  requiredFields?: readonly string[];
  /** Require selected fields to use a particular origin. */
  expectedOrigins?: Readonly<Record<string, PublicProspectFieldOrigin>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(field: string, message: string, keyword?: string): never {
  throw new ValidationError(message, {
    field,
    ...(keyword === undefined
      ? {}
      : {
          issues: [{ path: field, message, keyword }]
        })
  });
}

function normalizeText(
  value: unknown,
  field: string,
  maxLength: number,
  required = true
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    return validationError(field, `${field} must be a string`, 'type');
  }
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    return validationError(
      field,
      `${field} contains unsupported control characters`,
      'pattern'
    );
  }

  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0) {
    if (!required) return undefined;
    return validationError(field, `${field} must not be empty`, 'nonEmpty');
  }
  if (normalized.length > maxLength) {
    return validationError(
      field,
      `${field} must be at most ${maxLength} characters`,
      'maxLength'
    );
  }
  return normalized;
}

function normalizeIdentifier(
  value: unknown,
  field: string,
  maxLength: number
): string {
  const normalized = normalizeText(value, field, maxLength)!;
  if (/\s/u.test(normalized)) {
    return validationError(field, `${field} must not contain whitespace`, 'pattern');
  }
  return normalized;
}

function isConsentMethod(value: unknown): value is PublicProspectConsentMethod {
  return (PUBLIC_PROSPECT_CONSENT_METHODS as readonly unknown[]).includes(value);
}

function isConsentStatus(value: unknown): value is PublicProspectConsentStatus {
  return (PUBLIC_PROSPECT_CONSENT_STATUSES as readonly unknown[]).includes(value);
}

function isFieldOrigin(value: unknown): value is PublicProspectFieldOrigin {
  return (PUBLIC_PROSPECT_FIELD_ORIGINS as readonly unknown[]).includes(value);
}

function isActorType(value: unknown): value is ActorContext['actorType'] {
  return value === 'human_ui' || value === 'agent';
}

function normalizeActor(value: unknown, field: string): ActorContext {
  if (!isPlainRecord(value)) {
    return validationError(field, `${field} must be an actor object`, 'type');
  }
  const keys = Object.keys(value);
  const unsupported = keys.find((key) => !['actorType', 'actorId'].includes(key));
  if (unsupported !== undefined) {
    return validationError(
      `${field}.${unsupported}`,
      `${field}.${unsupported} is not an allowed property`,
      'additionalProperties'
    );
  }
  if (!isActorType(value.actorType)) {
    return validationError(
      `${field}.actorType`,
      `${field}.actorType must be a supported actor type`,
      'enum'
    );
  }
  return {
    actorType: value.actorType,
    actorId: normalizeIdentifier(value.actorId, `${field}.actorId`, 128)
  };
}

function calendarTimestamp(value: string, field: string): number {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return validationError(
      field,
      `${field} must be a timezone-qualified ISO timestamp`,
      'format'
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    return validationError(field, `${field} contains an invalid calendar date`, 'format');
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return validationError(field, `${field} must be a valid timestamp`, 'format');
  }
  return parsed;
}

/** Normalize any accepted timestamp to a byte-stable UTC ISO representation. */
export function normalizePublicProspectTimestamp(
  value: unknown,
  field = 'timestamp'
): Timestamp {
  if (typeof value !== 'string') {
    return validationError(field, `${field} must be a timestamp string`, 'type');
  }
  const normalized = value.normalize('NFKC').trim();
  const parsed = calendarTimestamp(normalized, field);
  return new Date(parsed).toISOString();
}

export const canonicalizePublicProspectTimestamp = normalizePublicProspectTimestamp;

function isGitHubHost(hostname: string): boolean {
  return GITHUB_HOSTS.has(hostname.toLowerCase());
}

function normalizeGitHubUrl(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    return validationError(field, `${field} must be a URL string`, 'type');
  }
  const input = value.normalize('NFKC').trim();
  if (input.length === 0) {
    return validationError(field, `${field} must not be empty`, 'nonEmpty');
  }
  if (/[\u0000-\u001F\u007F]/u.test(input) || /\s/u.test(input)) {
    return validationError(field, `${field} contains unsupported whitespace`, 'pattern');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return validationError(field, `${field} must be an absolute URL`, 'format');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return validationError(field, `${field} must use http or https`, 'protocol');
  }
  if (!isGitHubHost(parsed.hostname)) {
    return validationError(field, `${field} must use an allowlisted GitHub host`, 'host');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return validationError(field, `${field} must not contain URL credentials`, 'security');
  }

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }
  parsed.hash = '';
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  }
  if (parsed.search !== '') parsed.searchParams.sort();

  const canonical = parsed.toString();
  if (canonical.length > PUBLIC_PROSPECT_URL_MAX_LENGTH) {
    return validationError(
      field,
      `${field} must be at most ${PUBLIC_PROSPECT_URL_MAX_LENGTH} characters`,
      'maxLength'
    );
  }
  return canonical;
}

function normalizeSourceFilters(value: unknown): PublicProspectSourceFilters | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    return validationError('sourceFilters', 'sourceFilters must be an object', 'type');
  }
  const unsupported = Object.keys(value).find(
    (key) => !['language', 'location'].includes(key)
  );
  if (unsupported !== undefined) {
    return validationError(
      `sourceFilters.${unsupported}`,
      `sourceFilters.${unsupported} is not an allowed property`,
      'additionalProperties'
    );
  }

  const language = normalizeText(
    value.language,
    'sourceFilters.language',
    GITHUB_PROSPECT_FILTER_MAX_LENGTH,
    false
  );
  const location = normalizeText(
    value.location,
    'sourceFilters.location',
    GITHUB_PROSPECT_FILTER_MAX_LENGTH,
    false
  );
  if (language === undefined && location === undefined) return undefined;
  return {
    ...(language === undefined ? {} : { language }),
    ...(location === undefined ? {} : { location })
  };
}

function normalizeAttribution(value: unknown): GitHubProspectAttribution {
  if (!isPlainRecord(value)) {
    return validationError('attribution', 'attribution must be an object', 'type');
  }
  const allowed = [
    'source',
    'apiUrl',
    'searchApiDocsUrl',
    'rateLimitsDocsUrl',
    'userApiDocsUrl'
  ];
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) {
    return validationError(
      `attribution.${unsupported}`,
      `attribution.${unsupported} is not an allowed property`,
      'additionalProperties'
    );
  }
  if (value.source !== GITHUB_PROSPECT_SOURCE) {
    return validationError(
      'attribution.source',
      'attribution.source must identify GitHub',
      'const'
    );
  }
  return {
    source: GITHUB_PROSPECT_SOURCE,
    apiUrl: normalizeGitHubUrl(value.apiUrl, 'attribution.apiUrl'),
    searchApiDocsUrl: normalizeGitHubUrl(
      value.searchApiDocsUrl,
      'attribution.searchApiDocsUrl'
    ),
    rateLimitsDocsUrl: normalizeGitHubUrl(
      value.rateLimitsDocsUrl,
      'attribution.rateLimitsDocsUrl'
    ),
    userApiDocsUrl: normalizeGitHubUrl(
      value.userApiDocsUrl,
      'attribution.userApiDocsUrl'
    )
  };
}

/**
 * Canonicalize the immutable source facts carried by an imported prospect.
 * Canonical output has fixed property order, normalized text/timestamps/URLs,
 * and no unknown properties.
 */
export function normalizePublicProspectSourceReference(
  value: unknown
): PublicProspectSourceReference {
  if (!isPlainRecord(value)) {
    return validationError(
      'sourceReference',
      'public prospect source reference must be an object',
      'type'
    );
  }
  const allowed = [
    'source',
    'sourceRecordId',
    'profileUrl',
    'canonicalSourceUrl',
    'sourceQuery',
    'sourceFilters',
    'fetchedAt',
    'attribution'
  ];
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) {
    return validationError(
      `sourceReference.${unsupported}`,
      `sourceReference.${unsupported} is not an allowed property`,
      'additionalProperties'
    );
  }
  if (value.source !== GITHUB_PROSPECT_SOURCE) {
    return validationError(
      'sourceReference.source',
      'sourceReference.source must identify GitHub',
      'const'
    );
  }

  const sourceRecordId = normalizeIdentifier(
    value.sourceRecordId,
    'sourceReference.sourceRecordId',
    PUBLIC_PROSPECT_SOURCE_RECORD_MAX_LENGTH
  );
  const profileUrl = normalizeGitHubUrl(value.profileUrl, 'sourceReference.profileUrl');
  const canonicalSourceUrl = normalizeGitHubUrl(
    value.canonicalSourceUrl,
    'sourceReference.canonicalSourceUrl'
  );
  const sourceQuery = normalizeText(
    value.sourceQuery,
    'sourceReference.sourceQuery',
    GITHUB_PROSPECT_QUERY_MAX_LENGTH
  )!;
  const sourceFilters = normalizeSourceFilters(value.sourceFilters);
  const fetchedAt = normalizePublicProspectTimestamp(
    value.fetchedAt,
    'sourceReference.fetchedAt'
  );
  const attribution = normalizeAttribution(value.attribution);

  return {
    source: GITHUB_PROSPECT_SOURCE,
    sourceRecordId,
    profileUrl,
    canonicalSourceUrl,
    sourceQuery,
    ...(sourceFilters === undefined ? {} : { sourceFilters }),
    fetchedAt,
    attribution
  };
}

export const canonicalizePublicProspectSourceReference =
  normalizePublicProspectSourceReference;
export const normalizePublicProspectProvenance =
  normalizePublicProspectSourceReference;

/** Normalize safe consent metadata; evidence contents are never accepted here. */
export function normalizePublicProspectConsent(
  value: unknown
): PublicProspectConsent {
  if (!isPlainRecord(value)) {
    return validationError('consent', 'public prospect consent must be an object', 'type');
  }
  const allowed = [
    'method',
    'scope',
    'capturedAt',
    'capturedBy',
    'evidenceRef',
    'policyVersion'
  ];
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) {
    return validationError(
      `consent.${unsupported}`,
      `consent.${unsupported} is not an allowed property`,
      'additionalProperties'
    );
  }
  if (!isConsentMethod(value.method)) {
    return validationError('consent.method', 'consent.method is not supported', 'enum');
  }
  return {
    method: value.method,
    scope: normalizeText(value.scope, 'consent.scope', PUBLIC_PROSPECT_SCOPE_MAX_LENGTH)!,
    capturedAt: normalizePublicProspectTimestamp(value.capturedAt, 'consent.capturedAt'),
    capturedBy: normalizeActor(value.capturedBy, 'consent.capturedBy'),
    evidenceRef: normalizeIdentifier(
      value.evidenceRef,
      'consent.evidenceRef',
      PUBLIC_PROSPECT_EVIDENCE_REFERENCE_MAX_LENGTH
    ),
    policyVersion: normalizeText(
      value.policyVersion,
      'consent.policyVersion',
      PUBLIC_PROSPECT_POLICY_VERSION_MAX_LENGTH
    )!
  };
}

export const canonicalizePublicProspectConsent = normalizePublicProspectConsent;
export const validatePublicProspectConsent = normalizePublicProspectConsent;

/**
 * Validate and return a sorted, cloned per-field provenance map. `requiredFields`
 * and `expectedOrigins` let an import boundary enforce its own retained-field
 * manifest without coupling this utility to candidate/profile schemas.
 */
export function normalizePublicProspectFieldOrigins(
  value: unknown,
  options: PublicProspectFieldOriginValidationOptions = {}
): Record<string, PublicProspectFieldOrigin> {
  if (!isPlainRecord(value)) {
    return validationError('fieldOrigins', 'fieldOrigins must be an object', 'type');
  }
  const keys = Object.keys(value);
  if (keys.length > PUBLIC_PROSPECT_MAX_FIELD_ORIGINS) {
    return validationError(
      'fieldOrigins',
      `fieldOrigins must contain at most ${PUBLIC_PROSPECT_MAX_FIELD_ORIGINS} fields`,
      'maxProperties'
    );
  }

  const result: Record<string, PublicProspectFieldOrigin> = {};
  const canonicalFields = new Set<string>();
  for (const field of [...keys].sort()) {
    const normalizedField = normalizeIdentifier(
      field,
      `fieldOrigins.${field}`,
      PUBLIC_PROSPECT_FIELD_NAME_MAX_LENGTH
    );
    if (canonicalFields.has(normalizedField)) {
      return validationError(
        `fieldOrigins.${field}`,
        `fieldOrigins contains duplicate canonical field ${normalizedField}`,
        'duplicate'
      );
    }
    canonicalFields.add(normalizedField);
    if (!isFieldOrigin(value[field])) {
      return validationError(
        `fieldOrigins.${field}`,
        `fieldOrigins.${field} must be a supported origin`,
        'enum'
      );
    }
    result[normalizedField] = value[field];
  }

  for (const requiredField of options.requiredFields ?? []) {
    const normalizedRequired = normalizeIdentifier(
      requiredField,
      `fieldOrigins.requiredFields`,
      PUBLIC_PROSPECT_FIELD_NAME_MAX_LENGTH
    );
    if (!Object.prototype.hasOwnProperty.call(result, normalizedRequired)) {
      return validationError(
        `fieldOrigins.${normalizedRequired}`,
        `fieldOrigins.${normalizedRequired} is required`,
        'required'
      );
    }
  }

  for (const [field, expectedOrigin] of Object.entries(options.expectedOrigins ?? {})) {
    const normalizedField = normalizeIdentifier(
      field,
      `fieldOrigins.expectedOrigins.${field}`,
      PUBLIC_PROSPECT_FIELD_NAME_MAX_LENGTH
    );
    if (!isFieldOrigin(expectedOrigin)) {
      return validationError(
        `fieldOrigins.expectedOrigins.${field}`,
        `fieldOrigins.expectedOrigins.${field} must be a supported origin`,
        'enum'
      );
    }
    if (result[normalizedField] !== expectedOrigin) {
      return validationError(
        `fieldOrigins.${normalizedField}`,
        `fieldOrigins.${normalizedField} must originate from ${expectedOrigin}`,
        'origin'
      );
    }
  }

  return result;
}

export const validatePublicProspectFieldOrigins = normalizePublicProspectFieldOrigins;
export const canonicalizePublicProspectFieldOrigins = normalizePublicProspectFieldOrigins;

export function isPublicProspectRetentionActive(
  retentionExpiresAt: Timestamp,
  now: Timestamp
): boolean {
  try {
    return parsePublicProspectTimestamp(retentionExpiresAt, 'retentionExpiresAt') >
      parsePublicProspectTimestamp(now, 'now');
  } catch {
    return false;
  }
}

export function getPublicProspectRetentionStatus(
  retentionExpiresAt: Timestamp,
  now: Timestamp
): PublicProspectRetentionStatus {
  try {
    return parsePublicProspectTimestamp(retentionExpiresAt, 'retentionExpiresAt') >
      parsePublicProspectTimestamp(now, 'now')
      ? 'active'
      : 'expired';
  } catch {
    return 'invalid';
  }
}

function parsePublicProspectTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') {
    return validationError(field, `${field} must be a timestamp string`, 'type');
  }
  const normalized = value.normalize('NFKC').trim();
  return calendarTimestamp(normalized, field);
}

function consentOptions(
  optionsOrNow: PublicProspectConsentCheckOptions | Timestamp
): PublicProspectConsentCheckOptions {
  if (typeof optionsOrNow === 'string') return { now: optionsOrNow };
  if (!isPlainRecord(optionsOrNow)) {
    return validationError('consentCheck', 'consent check options must be an object', 'type');
  }
  return {
    now: normalizePublicProspectTimestamp(optionsOrNow.now, 'consentCheck.now'),
    ...(optionsOrNow.requiredScope === undefined
      ? {}
      : {
          requiredScope: normalizeText(
            optionsOrNow.requiredScope,
            'consentCheck.requiredScope',
            PUBLIC_PROSPECT_SCOPE_MAX_LENGTH
          )
        }),
    ...(optionsOrNow.policyVersion === undefined
      ? {}
      : {
          policyVersion: normalizeText(
            optionsOrNow.policyVersion,
            'consentCheck.policyVersion',
            PUBLIC_PROSPECT_POLICY_VERSION_MAX_LENGTH
          )
        })
  };
}

/**
 * Evaluate whether a persisted prospect may be used now. This is a pure
 * decision: it does not rewrite `consentStatus` when retention has elapsed.
 */
export function evaluatePublicProspectConsent(
  record: Pick<
    SourcedProspectRecord,
    'consentStatus' | 'consent' | 'retentionExpiresAt'
  >,
  optionsOrNow: PublicProspectConsentCheckOptions | Timestamp
): PublicProspectConsentEvaluation {
  if (!isPlainRecord(record)) {
    return validationError('prospect', 'prospect consent state must be an object', 'type');
  }
  if (!isConsentStatus(record.consentStatus)) {
    return validationError('consentStatus', 'consentStatus is not supported', 'enum');
  }
  const options = consentOptions(optionsOrNow);
  const retentionStatus = getPublicProspectRetentionStatus(
    record.retentionExpiresAt,
    options.now
  );

  if (record.consentStatus === 'not_provided') {
    return {
      allowed: false,
      status: 'not_provided',
      reason: 'not_provided',
      consent: null
    };
  }
  if (record.consentStatus === 'withdrawn') {
    return {
      allowed: false,
      status: 'withdrawn',
      reason: 'withdrawn',
      consent: record.consent === null ? null : normalizePublicProspectConsent(record.consent)
    };
  }
  if (record.consentStatus === 'expired') {
    return {
      allowed: false,
      status: 'expired',
      reason: 'expired',
      consent: record.consent === null ? null : normalizePublicProspectConsent(record.consent)
    };
  }
  if (retentionStatus === 'invalid') {
    return {
      allowed: false,
      status: 'explicit',
      reason: 'invalid_retention',
      consent: null
    };
  }
  if (retentionStatus === 'expired') {
    return {
      allowed: false,
      status: 'expired',
      reason: 'retention_expired',
      consent: record.consent === null ? null : normalizePublicProspectConsent(record.consent)
    };
  }
  if (record.consent === null || record.consent === undefined) {
    return {
      allowed: false,
      status: 'explicit',
      reason: 'missing_consent',
      consent: null
    };
  }

  let consent: PublicProspectConsent;
  try {
    consent = normalizePublicProspectConsent(record.consent);
  } catch {
    return {
      allowed: false,
      status: 'explicit',
      reason: 'invalid_consent',
      consent: null
    };
  }

  const nowMs = parsePublicProspectTimestamp(options.now, 'consentCheck.now');
  const capturedMs = parsePublicProspectTimestamp(consent.capturedAt, 'consent.capturedAt');
  if (capturedMs > nowMs) {
    return { allowed: false, status: 'explicit', reason: 'captured_in_future', consent };
  }
  if (options.requiredScope !== undefined && consent.scope !== options.requiredScope) {
    return { allowed: false, status: 'explicit', reason: 'scope_mismatch', consent };
  }
  if (
    options.policyVersion !== undefined &&
    consent.policyVersion !== options.policyVersion
  ) {
    return { allowed: false, status: 'explicit', reason: 'policy_mismatch', consent };
  }

  return { allowed: true, status: 'explicit', reason: 'allowed', consent };
}

export function isPublicProspectConsentUsable(
  record: Pick<SourcedProspectRecord, 'consentStatus' | 'consent' | 'retentionExpiresAt'>,
  optionsOrNow: PublicProspectConsentCheckOptions | Timestamp
): boolean {
  return evaluatePublicProspectConsent(record, optionsOrNow).allowed;
}

export const canUsePublicProspect = isPublicProspectConsentUsable;
export const canImportPublicProspect = isPublicProspectConsentUsable;

/** Throw a structured validation error when an import/use boundary needs a hard guard. */
export function assertPublicProspectConsentUsable(
  record: Pick<SourcedProspectRecord, 'consentStatus' | 'consent' | 'retentionExpiresAt'>,
  optionsOrNow: PublicProspectConsentCheckOptions | Timestamp
): void {
  const decision = evaluatePublicProspectConsent(record, optionsOrNow);
  if (decision.allowed) return;
  throw new ValidationError('Public prospect consent is not usable', {
    field: 'consentStatus',
    reason: 'consent_invalid',
    consentReason: decision.reason,
    status: decision.status
  });
}

export const assertImportablePublicProspect = assertPublicProspectConsentUsable;

/** Return the canonical source/data-origin constants for provenance builders. */
export function isCanonicalPublicProspectSource(value: unknown): value is typeof GITHUB_PROSPECT_SOURCE {
  return value === GITHUB_PROSPECT_SOURCE;
}

export function isCanonicalPublicProspectDataOrigin(
  value: unknown
): value is typeof GITHUB_PROSPECT_DATA_ORIGIN {
  return value === GITHUB_PROSPECT_DATA_ORIGIN;
}
