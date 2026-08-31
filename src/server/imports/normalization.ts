import {
  PipelineError,
  type PipelineValidationIssue,
  ValidationError
} from '../../shared/errors';
import { isPlainObject } from '../../shared/validators';
import type {
  EmploymentMetadata,
  PublicCompensationRange,
  PublicJobListingNormalizationOptions,
  PublicJobListingRecord
} from './contracts';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

/** Collapse all Unicode whitespace and normalize compatible Unicode forms. */
export function normalizeWhitespace(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addIssue(
  issues: PipelineValidationIssue[],
  path: string,
  message: string,
  keyword?: string
): void {
  issues.push({ path, message, ...(keyword ? { keyword } : {}) });
}

function invalidListing(issues: PipelineValidationIssue[]): never {
  throw new ValidationError('Invalid public job listing record', {
    field: issues[0]?.path,
    issues
  });
}

function validationIssuesFrom(error: unknown, fallbackPath: string): PipelineValidationIssue[] {
  const pipelineError = PipelineError.from(error);
  const issues = pipelineError.details?.issues;
  if (issues !== undefined && issues.length > 0) {
    return [...issues];
  }
  return [{ path: fallbackPath, message: pipelineError.message }];
}

function normalizeRequiredText(
  value: unknown,
  path: string,
  issues: PipelineValidationIssue[]
): string | undefined {
  if (typeof value !== 'string') {
    addIssue(issues, path, 'must be a string', 'type');
    return undefined;
  }

  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) {
    addIssue(issues, path, 'must not be empty', 'nonEmpty');
    return undefined;
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  path: string,
  issues: PipelineValidationIssue[]
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredText(value, path, issues);
}

function normalizeKeylessSourceName(
  value: unknown,
  path: string,
  issues: PipelineValidationIssue[]
): string | undefined {
  return normalizeRequiredText(value, path, issues);
}

function assertCalendarDate(value: string, field: string): void {
  const datePart = value.slice(0, 10);
  const match = DATE_ONLY_PATTERN.exec(datePart);
  if (match === null) {
    throw new ValidationError(`${field} must use a calendar date`, {
      field,
      issues: [
        {
          path: field,
          message: 'must begin with a valid YYYY-MM-DD calendar date',
          keyword: 'format'
        }
      ]
    });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new ValidationError(`${field} contains an invalid calendar date`, {
      field,
      issues: [
        {
          path: field,
          message: 'contains an invalid calendar date',
          keyword: 'format'
        }
      ]
    });
  }
}

/** Normalize a date/date-time input to an unambiguous UTC ISO timestamp. */
export function normalizeDate(
  value: unknown,
  field = 'fetchedAt'
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a date string`, { field });
  }

  const normalizedInput = normalizeWhitespace(value);
  if (
    DATE_ONLY_PATTERN.test(normalizedInput) === false &&
    DATE_TIME_PATTERN.test(normalizedInput) === false
  ) {
    throw new ValidationError(
      `${field} must be an ISO date or ISO date-time with a timezone`,
      {
        field,
        issues: [
          {
            path: field,
            message: 'must be YYYY-MM-DD or a timezone-qualified ISO date-time',
            keyword: 'format'
          }
        ]
      }
    );
  }

  assertCalendarDate(normalizedInput, field);
  const parsed = Date.parse(normalizedInput);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} is not a valid date`, {
      field,
      issues: [
        {
          path: field,
          message: 'is not a valid date',
          keyword: 'format'
        }
      ]
    });
  }
  return new Date(parsed).toISOString();
}

/**
 * Canonicalize a public source URL without fetching it. Fragments are removed
 * because they do not identify a different server-side listing; query and
 * path content is otherwise retained for attribution.
 */
export function normalizeUrl(
  value: unknown,
  field = 'canonicalSourceUrl'
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a URL string`, { field });
  }

  const normalizedInput = normalizeWhitespace(value);
  if (normalizedInput.length === 0) {
    throw new ValidationError(`${field} must not be empty`, { field });
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedInput);
  } catch {
    throw new ValidationError(`${field} must be a valid absolute URL`, {
      field,
      issues: [
        {
          path: field,
          message: 'must be a valid absolute URL',
          keyword: 'format'
        }
      ]
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must use http or https`, {
      field,
      issues: [
        {
          path: field,
          message: 'must use the http or https protocol',
          keyword: 'protocol'
        }
      ]
    });
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError(`${field} must not contain credentials`, {
      field,
      issues: [
        {
          path: field,
          message: 'must not contain a username or password',
          keyword: 'security'
        }
      ]
    });
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
  return parsed.toString();
}

function normalizeCompensationRange(
  value: unknown,
  path: string,
  issues: PipelineValidationIssue[]
): PublicCompensationRange | undefined {
  if (!isPlainObject(value)) {
    addIssue(issues, path, 'must be an object', 'type');
    return undefined;
  }

  const min = value.min;
  const max = value.max;
  const currency = normalizeRequiredText(value.currency, `${path}.currency`, issues);

  if (typeof min !== 'number' || !Number.isFinite(min) || min < 0) {
    addIssue(issues, `${path}.min`, 'must be a non-negative finite number', 'minimum');
  }
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
    addIssue(issues, `${path}.max`, 'must be a non-negative finite number', 'maximum');
  }
  if (
    typeof min === 'number' &&
    Number.isFinite(min) &&
    typeof max === 'number' &&
    Number.isFinite(max) &&
    min > max
  ) {
    addIssue(issues, path, 'min must be less than or equal to max', 'comparison');
  }
  if (
    typeof min !== 'number' ||
    !Number.isFinite(min) ||
    min < 0 ||
    typeof max !== 'number' ||
    !Number.isFinite(max) ||
    max < 0 ||
    currency === undefined
  ) {
    return undefined;
  }
  return { min, max, currency };
}

function normalizeEmploymentMetadata(
  value: unknown,
  path: string,
  issues: PipelineValidationIssue[]
): EmploymentMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    addIssue(issues, path, 'must be an object', 'type');
    return undefined;
  }

  const allowedKeys = new Set([
    'employmentType',
    'workplaceType',
    'compensationRange'
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, `${path}.${key}`, 'is not an allowed property', 'additionalProperties');
    }
  }

  const employmentType = normalizeOptionalText(
    value.employmentType,
    `${path}.employmentType`,
    issues
  );
  const workplaceType = normalizeOptionalText(
    value.workplaceType,
    `${path}.workplaceType`,
    issues
  );
  const compensationRange = value.compensationRange === undefined
    ? undefined
    : normalizeCompensationRange(
        value.compensationRange,
        `${path}.compensationRange`,
        issues
      );

  const metadata: EmploymentMetadata = {};
  if (employmentType !== undefined) metadata.employmentType = employmentType.toLowerCase();
  if (workplaceType !== undefined) metadata.workplaceType = workplaceType.toLowerCase();
  if (compensationRange !== undefined) metadata.compensationRange = compensationRange;
  return metadata;
}

/**
 * Normalize and validate one untrusted source payload. All failures contain
 * field paths and issue details so a batch importer can continue safely.
 */
export function normalizePublicJobListing(
  input: unknown,
  options: PublicJobListingNormalizationOptions = {}
): PublicJobListingRecord {
  if (!isPlainObject(input)) {
    invalidListing([
      {
        path: 'listing',
        message: 'must be an object',
        keyword: 'type'
      }
    ]);
  }

  const issues: PipelineValidationIssue[] = [];
  const raw = input as Record<string, unknown>;

  const title = normalizeRequiredText(raw.title, 'title', issues);
  const company = normalizeRequiredText(raw.company, 'company', issues);
  const location = normalizeRequiredText(raw.location, 'location', issues);
  const description = normalizeRequiredText(raw.description, 'description', issues);

  let requirements: string[] | undefined;
  if (!Array.isArray(raw.requirements)) {
    addIssue(issues, 'requirements', 'must be a non-empty array', 'type');
  } else if (raw.requirements.length === 0) {
    addIssue(issues, 'requirements', 'must not be empty', 'minItems');
  } else {
    requirements = [];
    raw.requirements.forEach((requirement, index) => {
      const normalized = normalizeRequiredText(
        requirement,
        `requirements[${index}]`,
        issues
      );
      if (normalized !== undefined) requirements!.push(normalized);
    });
  }

  const sourceValue = raw.sourceName === undefined
    ? options.sourceName
    : raw.sourceName;
  const sourceName = normalizeKeylessSourceName(sourceValue, 'sourceName', issues);
  if (
    sourceName !== undefined &&
    options.sourceName !== undefined &&
    normalizeWhitespace(options.sourceName) !== sourceName
  ) {
    addIssue(
      issues,
      'sourceName',
      'must match the adapter source attribution',
      'attribution'
    );
  }

  let canonicalSourceUrl: string | undefined;
  try {
    canonicalSourceUrl = normalizeUrl(raw.canonicalSourceUrl);
  } catch (error) {
    issues.push(...validationIssuesFrom(error, 'canonicalSourceUrl'));
  }

  const fetchedValue = raw.fetchedAt === undefined
    ? options.fetchedAt
    : raw.fetchedAt;
  let fetchedAt: string | undefined;
  try {
    fetchedAt = normalizeDate(fetchedValue, 'fetchedAt');
  } catch (error) {
    issues.push(...validationIssuesFrom(error, 'fetchedAt'));
  }

  let externalId: string | undefined;
  if (raw.externalId !== undefined && raw.externalId !== null) {
    externalId = normalizeRequiredText(raw.externalId, 'externalId', issues);
  }

  const employmentMetadata = normalizeEmploymentMetadata(
    raw.employmentMetadata,
    'employmentMetadata',
    issues
  );

  if (
    issues.length > 0 ||
    title === undefined ||
    company === undefined ||
    location === undefined ||
    description === undefined ||
    requirements === undefined ||
    sourceName === undefined ||
    canonicalSourceUrl === undefined ||
    fetchedAt === undefined
  ) {
    invalidListing(issues);
  }

  const record: PublicJobListingRecord = {
    title,
    company,
    location,
    description,
    requirements,
    sourceName,
    canonicalSourceUrl,
    fetchedAt
  };
  if (externalId !== undefined) record.externalId = externalId;
  if (employmentMetadata !== undefined) record.employmentMetadata = employmentMetadata;
  return record;
}

// Descriptive aliases for callers that use "job listing" terminology.
export const normalizePublicListing = normalizePublicJobListing;
export const canonicalizeUrl = normalizeUrl;
export const normalizeFetchedAt = normalizeDate;
