import { normalizeWhitespace } from '../normalization';

export type PublicJobSourceFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface PublicJobListingSourceAdapterOptions {
  fetcher?: PublicJobSourceFetch;
  userAgent?: string;
}

export type PublicJobAdapterErrorCode =
  | 'FETCH_ERROR'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'MALFORMED_PAYLOAD'
  | 'MALFORMED_LISTING';

export class PublicJobListingAdapterError extends Error {
  readonly code: PublicJobAdapterErrorCode;
  readonly field?: string;

  constructor(
    code: PublicJobAdapterErrorCode,
    message: string,
    field?: string
  ) {
    super(message);
    this.name = 'PublicJobListingAdapterError';
    this.code = code;
    this.field = field;
  }
}

export const DEFAULT_PUBLIC_JOB_USER_AGENT =
  'PipelineOS public jobs catalog/1.0';

export function defaultPublicJobSourceFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') {
    throw new PublicJobListingAdapterError(
      'FETCH_ERROR',
      'This runtime does not provide fetch for public job sources'
    );
  }
  return globalThis.fetch(input, init);
}

export function resolveSourceAdapterOptions(
  options: PublicJobListingSourceAdapterOptions | PublicJobSourceFetch = {}
): Required<PublicJobListingSourceAdapterOptions> {
  if (typeof options === 'function') {
    return {
      fetcher: options,
      userAgent: DEFAULT_PUBLIC_JOB_USER_AGENT
    };
  }
  return {
    fetcher: options.fetcher ?? defaultPublicJobSourceFetch,
    userAgent: options.userAgent ?? DEFAULT_PUBLIC_JOB_USER_AGENT
  };
}

function sourceErrorMessage(response: Response): string {
  const status = typeof response.status === 'number' ? response.status : 0;
  const statusText = typeof response.statusText === 'string'
    ? response.statusText.trim()
    : '';
  return statusText.length > 0
    ? `Public job source returned HTTP ${status}: ${statusText}`
    : `Public job source returned HTTP ${status}`;
}

export async function fetchSourceJson(
  fetcher: PublicJobSourceFetch,
  sourceUrl: string,
  context: { signal?: AbortSignal },
  userAgent: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(sourceUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': userAgent
      },
      signal: context.signal
    });
  } catch (error) {
    if (error instanceof PublicJobListingAdapterError) throw error;
    const message = error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Public job source request failed';
    throw new PublicJobListingAdapterError('FETCH_ERROR', message);
  }

  if (!response || response.ok !== true) {
    throw new PublicJobListingAdapterError(
      'HTTP_ERROR',
      sourceErrorMessage(response)
    );
  }

  try {
    return await response.json() as unknown;
  } catch {
    throw new PublicJobListingAdapterError(
      'INVALID_JSON',
      'Public job source returned invalid JSON'
    );
  }
}

export function assertRecord(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new PublicJobListingAdapterError(
      'MALFORMED_PAYLOAD',
      `${path} must be an object`,
      path
    );
  }
  return value as Record<string, unknown>;
}

export function assertArray(
  value: unknown,
  path: string
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PublicJobListingAdapterError(
      'MALFORMED_PAYLOAD',
      `${path} must be an array`,
      path
    );
  }
  return value;
}

export function requiredPlainText(
  value: unknown,
  path: string
): string {
  if (typeof value !== 'string') {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must be a non-empty string`,
      path
    );
  }
  const normalized = htmlToPlainText(value);
  if (normalized.length === 0) {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must be a non-empty string`,
      path
    );
  }
  return normalized;
}

export function optionalPlainText(
  value: unknown,
  path: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must be a string when present`,
      path
    );
  }
  const normalized = htmlToPlainText(value);
  return normalized.length === 0 ? undefined : normalized;
}

export function optionalId(
  value: unknown,
  path: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must be a string or number when present`,
      path
    );
  }
  const normalized = normalizeWhitespace(String(value));
  if (normalized.length === 0) {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must not be empty when present`,
      path
    );
  }
  return normalized;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu,
    (entity, token: string) => {
      const lower = token.toLowerCase();
      if (lower.startsWith('#x')) {
        const codePoint = Number.parseInt(lower.slice(2), 16);
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (lower.startsWith('#')) {
        const codePoint = Number.parseInt(lower.slice(1), 10);
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return namedEntities[lower] ?? entity;
    }
  );
}

/** Convert source HTML or entities into safe plain text before storage/rendering. */
export function htmlToPlainText(value: string): string {
  let decoded = value;
  // Decode before and after tag removal so encoded markup cannot survive as text.
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decodeHtmlEntities(decoded);
  }
  decoded = decoded
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<\/li\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ');
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decodeHtmlEntities(decoded);
  }
  return normalizeWhitespace(decoded);
}

function sourceTextValues(
  value: unknown,
  path: string
): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const [index, item] of values.entries()) {
    if (typeof item !== 'string') {
      throw new PublicJobListingAdapterError(
        'MALFORMED_LISTING',
        `${path}[${index}] must be a string`,
        `${path}[${index}]`
      );
    }
    const plain = htmlToPlainText(item);
    for (const part of plain.split(/[|,;\n]+/u)) {
      const normalized = normalizeWhitespace(part);
      if (normalized.length > 0) result.push(normalized);
    }
  }
  return result;
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

/**
 * Derive stable, non-empty requirements without inventing candidate data.
 * Source tags/industry are preferred; relevant description sentences provide
 * a deterministic fallback when the source does not publish tags.
 */
export function deriveRequirements(
  tags: unknown,
  industry: unknown,
  description: string,
  paths = { tags: 'tags', industry: 'industry' }
): string[] {
  const values = uniqueValues([
    ...sourceTextValues(tags, paths.tags),
    ...sourceTextValues(industry, paths.industry)
  ]);
  const sentences = description
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length > 0);
  const relevantSentences = sentences.filter((sentence) =>
    /\b(?:experience|expertise|skill|knowledge|proficien|ability|responsibilit|develop|build|design|engineer|require)\w*/iu.test(sentence)
  );
  const descriptionRequirements = (relevantSentences.length > 0
    ? relevantSentences
    : sentences.slice(0, 1)
  ).map((sentence) => sentence.slice(0, 240));
  const combined = uniqueValues([...values, ...descriptionRequirements]);
  if (combined.length === 0) {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      'listing must provide tags, industry, or a non-empty description',
      'requirements'
    );
  }
  return combined.slice(0, 20);
}

export function optionalTextList(
  value: unknown,
  path: string
): string[] {
  return sourceTextValues(value, path);
}

export function optionalBoolean(
  value: unknown,
  path: string
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must be a boolean when present`,
      path
    );
  }
  return value;
}

export function optionalFiniteNumber(
  value: unknown,
  path: string
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PublicJobListingAdapterError(
      'MALFORMED_LISTING',
      `${path} must be a non-negative finite number when present`,
      path
    );
  }
  return parsed;
}

export function optionalCurrency(
  value: unknown,
  path: string
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredPlainText(value, path);
}

export function compensationRange(
  min: number | undefined,
  max: number | undefined,
  currency: string | undefined
): { min: number; max: number; currency: string } | undefined {
  if (min === undefined || max === undefined || currency === undefined) {
    return undefined;
  }
  if (min > max) return undefined;
  return { min, max, currency };
}
