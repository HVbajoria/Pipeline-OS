import type {
  PublicJobsRequestOptions,
  PublicJobsResult
} from '../server/imports/publicJobs';

export type PublicJobsFetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface PublicJobsClientOptions {
  baseUrl?: string;
  fetcher?: PublicJobsFetchLike;
}

export class PublicJobsClientError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'PublicJobsClientError';
    this.status = status;
    this.payload = payload;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === 'string' && error.message.trim().length > 0) {
      return error.message;
    }
  }
  return status >= 500
    ? 'Live public jobs service is unavailable'
    : 'Live public jobs request failed';
}

function assertResult(body: unknown): PublicJobsResult {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { listings?: unknown }).listings) ||
    !Array.isArray((body as { sources?: unknown }).sources) ||
    !Array.isArray((body as { errors?: unknown }).errors)
  ) {
    throw new PublicJobsClientError(
      502,
      'Live public jobs service returned an invalid response',
      body
    );
  }
  return body as PublicJobsResult;
}

/** Read-only client for the external catalog; it never hydrates or mutates the operation store. */
export class PublicJobsClient {
  private readonly baseUrl: string;
  private readonly fetcher: PublicJobsFetchLike;

  constructor(options: PublicJobsClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? '');
    const browserFetch = globalThis.fetch;
    if (!options.fetcher && typeof browserFetch !== 'function') {
      throw new Error('PublicJobsClient requires a fetch implementation');
    }
    this.fetcher = options.fetcher ?? browserFetch.bind(globalThis);
  }

  async getListings(
    options: PublicJobsRequestOptions = {}
  ): Promise<PublicJobsResult> {
    const query = options.refresh === true ? '?refresh=true' : '';
    const response = await this.fetcher(`${this.baseUrl}/api/public-jobs${query}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: options.signal
    });
    const body = await responseBody(response);
    if (!response.ok) {
      throw new PublicJobsClientError(
        response.status,
        responseErrorMessage(response.status, body),
        body
      );
    }
    return assertResult(body);
  }
}

export function createPublicJobsClient(
  options: PublicJobsClientOptions = {}
): PublicJobsClient {
  return new PublicJobsClient(options);
}

export const publicJobsClient = new PublicJobsClient();
