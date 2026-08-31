import {
  PipelineError,
  RateLimitedError,
  UpstreamError,
  ValidationError
} from '../../shared/errors';
import type { Timestamp } from '../../shared/models';

import {
  GITHUB_PROSPECT_CONSENT_STATUS,
  GITHUB_PROSPECT_DATA_ORIGIN,
  GITHUB_PROSPECT_SOURCE,
  normalizeGitHubProspectSearchInput
} from '../../shared/publicProspects';
import type {
  GitHubProspect,
  GitHubProspectAttribution,
  GitHubProspectCacheMetadata,
  GitHubProspectSearchInput,
  GitHubProspectSearchResult,
  NormalizedGitHubProspectSearchInput
} from '../../shared/publicProspects';

export {
  GITHUB_PROSPECT_CONSENT_STATUS,
  GITHUB_PROSPECT_DATA_ORIGIN,
  GITHUB_PROSPECT_SOURCE,
  normalizeGitHubProspectSearchInput
} from '../../shared/publicProspects';
export type {
  GitHubProspect,
  GitHubProspectAttribution,
  GitHubProspectCacheMetadata,
  GitHubProspectSearchInput,
  GitHubProspectSearchResult,
  NormalizedGitHubProspectSearchInput
} from '../../shared/publicProspects';

export const GITHUB_USERS_SEARCH_URL = 'https://api.github.com/search/users';
export const GITHUB_PROSPECTS_API_DOCS_URL =
  'https://docs.github.com/en/rest/search/search';
export const GITHUB_RATE_LIMITS_DOCS_URL =
  'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api';
export const GITHUB_USERS_DOCS_URL =
  'https://docs.github.com/en/rest/users/users';

export const DEFAULT_GITHUB_PROSPECT_MAX_RESULTS = 10;
export const MAX_GITHUB_PROSPECT_RESULTS = 25;
export const DEFAULT_GITHUB_PROSPECT_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_GITHUB_PROSPECT_USER_AGENT =
  'PipelineOS public GitHub prospect search/1.0';

export type GitHubProspectErrorCode =
  | 'FETCH_ERROR'
  | 'RATE_LIMITED'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'MALFORMED_PAYLOAD';

export interface GitHubProspectErrorDetails {
  status?: number;
  retryAfterSeconds?: number;
  resetAt?: Timestamp;
}

/**
 * Errors from the official GitHub API boundary. The raw upstream response is
 * deliberately not retained so tokens and full payloads cannot leak through
 * logs or API responses.
 */
export class GitHubProspectError extends Error {
  readonly code: GitHubProspectErrorCode;
  readonly status: 429 | 502;
  readonly details?: GitHubProspectErrorDetails;

  constructor(
    code: GitHubProspectErrorCode,
    message: string,
    status: 429 | 502,
    details?: GitHubProspectErrorDetails
  ) {
    super(message);
    this.name = 'GitHubProspectError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type GitHubProspectFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface GitHubProspectClock {
  now(): Timestamp;
}

export interface GitHubPublicProspectAdapterOptions {
  fetcher?: GitHubProspectFetch;
  /** Server-only token. It is used only to add an Authorization header. */
  token?: string;
  userAgent?: string;
  maxResults?: number;
  clock?: GitHubProspectClock;
}

export interface GitHubProspectRequestOptions {
  signal?: AbortSignal;
  maxResults?: number;
}

export interface GitHubProspectAdapter {
  search(
    input: GitHubProspectSearchInput,
    options?: GitHubProspectRequestOptions
  ): Promise<GitHubProspect[]>;
}

export interface GitHubProspectServiceOptions
  extends GitHubPublicProspectAdapterOptions {
  adapter?: GitHubProspectAdapter;
  cacheTtlMs?: number;
}

export interface GitHubProspectServiceApi {
  search(
    input: GitHubProspectSearchInput,
    options?: GitHubProspectRequestOptions
  ): Promise<GitHubProspectSearchResult>;
  clearCache(): void;
}

const ATTRIBUTION: GitHubProspectAttribution = {
  source: GITHUB_PROSPECT_SOURCE,
  apiUrl: GITHUB_USERS_SEARCH_URL,
  searchApiDocsUrl: GITHUB_PROSPECTS_API_DOCS_URL,
  rateLimitsDocsUrl: GITHUB_RATE_LIMITS_DOCS_URL,
  userApiDocsUrl: GITHUB_USERS_DOCS_URL
};

function defaultClock(): GitHubProspectClock {
  return { now: () => new Date().toISOString() };
}

function defaultFetcher(input: string, init?: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') {
    throw new GitHubProspectError(
      'FETCH_ERROR',
      'This runtime does not provide fetch for GitHub prospects',
      502
    );
  }
  return globalThis.fetch(input, init);
}

function normalizeTimestamp(value: Timestamp): Timestamp {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('GitHub prospect clock returned an invalid timestamp');
  }
  return parsed.toISOString();
}

function validateMaxResults(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_GITHUB_PROSPECT_RESULTS
  ) {
    throw new ValidationError(
      `GitHub prospect result limit must be an integer from 1 through ${MAX_GITHUB_PROSPECT_RESULTS}`,
      { field: 'maxResults' }
    );
  }
  return value;
}

function quotedQualifier(value: string): string {
  if (!/\s|["\\]/u.test(value)) return value;
  return `"${value.replace(/["\\]/gu, '\\$&')}"`;
}

/** Build the GitHub `q` expression without concatenating an unescaped URL. */
export function buildGitHubUsersSearchQuery(
  input: GitHubProspectSearchInput
): string {
  const normalized = normalizeGitHubProspectSearchInput(input);
  const parts = [normalized.query];
  if (normalized.language) {
    parts.push(`language:${quotedQualifier(normalized.language)}`);
  }
  if (normalized.location) {
    parts.push(`location:${quotedQualifier(normalized.location)}`);
  }
  return parts.join(' ');
}

export function buildGitHubUsersSearchUrl(
  input: GitHubProspectSearchInput,
  maxResults = DEFAULT_GITHUB_PROSPECT_MAX_RESULTS
): string {
  const limit = validateMaxResults(maxResults);
  const url = new URL(GITHUB_USERS_SEARCH_URL);
  url.searchParams.set('q', buildGitHubUsersSearchQuery(input));
  url.searchParams.set('per_page', String(limit));
  return url.toString();
}

function responseHeader(response: Response, name: string): string | undefined {
  const headers = response.headers;
  if (headers && typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  const record = headers as unknown as Record<string, unknown> | undefined;
  const value = record?.[name] ?? record?.[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function responseStatus(response: Response): number {
  return typeof response.status === 'number' ? response.status : 0;
}

function responseIsOk(response: Response): boolean {
  const status = responseStatus(response);
  if (status >= 200 && status < 300) return true;
  return response.ok === true;
}

function retryDetails(response: Response): GitHubProspectErrorDetails | undefined {
  const retryAfter = responseHeader(response, 'retry-after');
  const resetHeader = responseHeader(response, 'x-ratelimit-reset');
  const details: GitHubProspectErrorDetails = {};

  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      details.retryAfterSeconds = Math.ceil(seconds);
    } else {
      const retryDate = Date.parse(retryAfter);
      if (Number.isFinite(retryDate)) {
        details.retryAfterSeconds = Math.max(
          0,
          Math.ceil((retryDate - Date.now()) / 1000)
        );
      }
    }
  }
  if (resetHeader) {
    const resetSeconds = Number(resetHeader);
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      details.resetAt = new Date(resetSeconds * 1000).toISOString();
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function isRateLimitedResponse(response: Response, bodyMessage = ''): boolean {
  const status = responseStatus(response);
  const remaining = responseHeader(response, 'x-ratelimit-remaining');
  return (
    status === 429 ||
    (status === 403 && remaining === '0') ||
    (status === 403 && /rate limit|rate-limit|abuse detection/iu.test(bodyMessage))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      `GitHub users search item field ${field} is malformed`,
      502
    );
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      `GitHub users search item field ${field} is malformed`,
      502
    );
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function optionalSafePublicText(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = optionalString(record, field);
  if (value === undefined) return undefined;
  const containsEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value);
  const containsPhone = /\+?\d[\d\s().-]{6,}\d/u.test(value);
  return containsEmail || containsPhone ? undefined : value;
}

function assertHttpsUrl(value: string, field: string, host?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      `GitHub users search item field ${field} is not a valid URL`,
      502
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    (host !== undefined && parsed.hostname !== host)
  ) {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      `GitHub users search item field ${field} is not a permitted HTTPS URL`,
      502
    );
  }
  return parsed.toString();
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      `GitHub users search item field ${field} is malformed`,
      502
    );
  }
  return value as number;
}

function mapUser(
  item: unknown,
  query: string,
  fetchedAt: Timestamp
): GitHubProspect {
  if (!isRecord(item)) {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      'GitHub users search items must contain objects',
      502
    );
  }

  const login = requiredString(item, 'login');
  const profileUrl = assertHttpsUrl(
    requiredString(item, 'html_url'),
    'html_url',
    'github.com'
  );
  const avatarUrlValue = optionalString(item, 'avatar_url');
  const profileType = requiredString(item, 'type');
  const score = item.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      'GitHub users search item field score is malformed',
      502
    );
  }

  const location = optionalSafePublicText(item, 'location');
  const bio = optionalSafePublicText(item, 'bio');
  const publicRepos = optionalNonNegativeInteger(item, 'public_repos');
  const prospect: GitHubProspect = {
    source: GITHUB_PROSPECT_SOURCE,
    sourceUrl: profileUrl,
    profileUrl,
    username: login,
    login,
    ...(avatarUrlValue === undefined
      ? {}
      : { avatarUrl: assertHttpsUrl(avatarUrlValue, 'avatar_url') }),
    profileType,
    searchScore: score,
    query,
    fetchedAt,
    dataOrigin: GITHUB_PROSPECT_DATA_ORIGIN,
    consentStatus: GITHUB_PROSPECT_CONSENT_STATUS,
    ...(location === undefined ? {} : { location }),
    ...(bio === undefined ? {} : { bio }),
    ...(publicRepos === undefined ? {} : { publicRepos })
  };
  return prospect;
}

function bodyMessage(value: unknown): string {
  if (!isRecord(value) || typeof value.message !== 'string') return '';
  return value.message;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GitHubProspectError(
      'INVALID_JSON',
      'GitHub users search returned invalid JSON',
      502
    );
  }
}

function validatePayload(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new GitHubProspectError(
      'MALFORMED_PAYLOAD',
      'GitHub users search returned a malformed payload',
      502
    );
  }
  return payload.items;
}

function cloneProspect(prospect: GitHubProspect): GitHubProspect {
  return { ...prospect };
}

function cloneProspects(prospects: readonly GitHubProspect[]): GitHubProspect[] {
  return prospects.map(cloneProspect);
}

function cacheKey(input: NormalizedGitHubProspectSearchInput): string {
  return [input.query, input.language ?? '', input.location ?? '']
    .map((value) => value.toLocaleLowerCase())
    .join('\u001f');
}

function defaultOptions(
  options: GitHubPublicProspectAdapterOptions | GitHubProspectFetch = {}
): Required<Pick<GitHubPublicProspectAdapterOptions, 'fetcher' | 'userAgent' | 'maxResults' | 'clock'>> &
  Pick<GitHubPublicProspectAdapterOptions, 'token'> {
  const values = typeof options === 'function' ? { fetcher: options } : options;
  const maxResults = validateMaxResults(
    values.maxResults ?? DEFAULT_GITHUB_PROSPECT_MAX_RESULTS
  );
  const userAgent = values.userAgent?.trim() || DEFAULT_GITHUB_PROSPECT_USER_AGENT;
  return {
    fetcher: values.fetcher ?? defaultFetcher,
    userAgent,
    maxResults,
    clock: values.clock ?? defaultClock(),
    token: values.token?.trim() || undefined
  };
}

/** Official GitHub REST `/search/users` adapter with an injected fetcher. */
export class GitHubPublicProspectAdapter implements GitHubProspectAdapter {
  readonly maxResults: number;
  readonly userAgent: string;

  private readonly fetcher: GitHubProspectFetch;
  private readonly token?: string;
  private readonly clock: GitHubProspectClock;

  constructor(options: GitHubPublicProspectAdapterOptions | GitHubProspectFetch = {}) {
    const resolved = defaultOptions(options);
    this.fetcher = resolved.fetcher;
    this.token = resolved.token;
    this.clock = resolved.clock;
    this.maxResults = resolved.maxResults;
    this.userAgent = resolved.userAgent;
  }

  async search(
    input: GitHubProspectSearchInput,
    options: GitHubProspectRequestOptions = {}
  ): Promise<GitHubProspect[]> {
    const normalized = normalizeGitHubProspectSearchInput(input);
    const maxResults = validateMaxResults(options.maxResults ?? this.maxResults);
    const query = buildGitHubUsersSearchQuery(normalized);
    const url = buildGitHubUsersSearchUrl(normalized, maxResults);
    const fetchedAt = normalizeTimestamp(this.clock.now());
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': this.userAgent,
      'x-github-api-version': '2022-11-28'
    };
    // The token is held only by this server-side adapter and is never placed
    // in the URL, result, error message, or browser-facing client module.
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers,
        signal: options.signal
      });
    } catch (error) {
      if (error instanceof GitHubProspectError) throw error;
      throw new GitHubProspectError(
        'FETCH_ERROR',
        'GitHub users search request failed',
        502
      );
    }

    if (!responseIsOk(response)) {
      let message = '';
      try {
        message = bodyMessage(await response.json());
      } catch {
        // The status itself is enough to classify this upstream failure.
      }
      if (isRateLimitedResponse(response, message)) {
        throw new GitHubProspectError(
          'RATE_LIMITED',
          'GitHub API rate limit reached; try again later',
          429,
          retryDetails(response)
        );
      }
      throw new GitHubProspectError(
        'HTTP_ERROR',
        `GitHub users search returned HTTP ${responseStatus(response)}`,
        502,
        { status: responseStatus(response) }
      );
    }

    const payload = await parseJson(response);
    const items = validatePayload(payload);
    return cloneProspects(
      items.slice(0, maxResults).map((item) => mapUser(item, query, fetchedAt))
    );
  }

  fetchProspects = this.search.bind(this);
}

interface GitHubCacheEntry {
  prospects: GitHubProspect[];
  query: string;
  filters: NormalizedGitHubProspectSearchInput;
  fetchedAt: Timestamp;
  expiresAtMs: number;
}

function validCacheTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('GitHub prospect cache TTL must be a positive finite number');
  }
  return value;
}

function resultFromEntry(
  entry: GitHubCacheEntry,
  nowMs: number,
  ttlMs: number,
  hit: boolean,
  coalesced: boolean
): GitHubProspectSearchResult {
  const expiresAt = new Date(entry.expiresAtMs).toISOString();
  return {
    prospects: cloneProspects(entry.prospects),
    query: entry.query,
    filters: { ...entry.filters },
    source: GITHUB_PROSPECT_SOURCE,
    fetchedAt: entry.fetchedAt,
    cache: {
      hit,
      coalesced,
      ageMs: Math.max(0, nowMs - Date.parse(entry.fetchedAt)),
      ttlMs,
      fetchedAt: entry.fetchedAt,
      expiresAt
    },
    attribution: { ...ATTRIBUTION }
  };
}

/**
 * On-demand cached service for public prospects. Errors are never cached, and
 * concurrent identical searches share one upstream promise where practical.
 */
export class GitHubProspectService implements GitHubProspectServiceApi {
  readonly cacheTtlMs: number;
  readonly maxResults: number;

  private readonly adapter: GitHubProspectAdapter;
  private readonly clock: GitHubProspectClock;
  private readonly cache = new Map<string, GitHubCacheEntry>();
  private readonly inFlight = new Map<string, Promise<GitHubCacheEntry>>();

  constructor(options: GitHubProspectServiceOptions = {}) {
    this.maxResults = validateMaxResults(
      options.maxResults ?? DEFAULT_GITHUB_PROSPECT_MAX_RESULTS
    );
    this.cacheTtlMs = validCacheTtl(
      options.cacheTtlMs ?? DEFAULT_GITHUB_PROSPECT_CACHE_TTL_MS
    );
    this.clock = options.clock ?? defaultClock();
    this.adapter = options.adapter ?? new GitHubPublicProspectAdapter({
      fetcher: options.fetcher,
      token: options.token,
      userAgent: options.userAgent,
      maxResults: this.maxResults,
      clock: this.clock
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  async search(
    input: GitHubProspectSearchInput,
    options: GitHubProspectRequestOptions = {}
  ): Promise<GitHubProspectSearchResult> {
    const filters = normalizeGitHubProspectSearchInput(input);
    const key = cacheKey(filters);
    const requestedAt = normalizeTimestamp(this.clock.now());
    const requestedAtMs = Date.parse(requestedAt);
    const cached = this.cache.get(key);

    if (cached && requestedAtMs < cached.expiresAtMs) {
      return resultFromEntry(cached, requestedAtMs, this.cacheTtlMs, true, false);
    }

    const running = this.inFlight.get(key);
    if (running) {
      const entry = await running;
      const joinedAt = Date.parse(normalizeTimestamp(this.clock.now()));
      return resultFromEntry(entry, joinedAt, this.cacheTtlMs, true, true);
    }

    const query = buildGitHubUsersSearchQuery(filters);
    const request = this.adapter
      .search(filters, {
        signal: options.signal,
        maxResults: this.maxResults
      })
      .then((prospects) => {
        const safeProspects = cloneProspects(prospects).slice(0, this.maxResults);
        const fetchedAt = safeProspects[0]?.fetchedAt ?? requestedAt;
        const entry: GitHubCacheEntry = {
          prospects: safeProspects,
          query,
          filters: { ...filters },
          fetchedAt,
          expiresAtMs: requestedAtMs + this.cacheTtlMs
        };
        this.cache.set(key, entry);
        return entry;
      });
    this.inFlight.set(key, request);

    try {
      const entry = await request;
      return resultFromEntry(entry, requestedAtMs, this.cacheTtlMs, false, false);
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    }
  }

  getProspects = this.search.bind(this);
}

function safeGitHubErrorDetails(
  error: GitHubProspectError
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    source: GITHUB_PROSPECT_SOURCE,
    upstreamCode: error.code
  };
  const status = error.details?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    details.status = status;
  }
  const retryAfterSeconds = error.details?.retryAfterSeconds;
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    details.retryAfterSeconds = Math.ceil(retryAfterSeconds);
  }
  const resetAt = error.details?.resetAt;
  if (typeof resetAt === 'string' && Number.isFinite(Date.parse(resetAt))) {
    details.resetAt = new Date(resetAt).toISOString();
  }
  return details;
}

export function toGitHubPipelineError(error: unknown): PipelineError {
  if (error instanceof GitHubProspectError) {
    const details = safeGitHubErrorDetails(error);
    if (error.code === 'RATE_LIMITED') {
      return new RateLimitedError(
        'GitHub API rate limit reached; try again later',
        details
      );
    }
    return new UpstreamError(
      'GitHub public-prospect service unavailable',
      details
    );
  }
  return PipelineError.from(error);
}

export function createGitHubProspectService(
  options: GitHubProspectServiceOptions = {}
): GitHubProspectService {
  return new GitHubProspectService(options);
}

export const GitHubProspectsCoordinator = GitHubProspectService;
export const createGitHubProspectsService = createGitHubProspectService;
