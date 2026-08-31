import type { ActorContext } from '../shared/models';
import {
  PipelineError,
  type PipelineErrorPayload
} from '../shared/errors';
import type {
  GitHubProspectSearchInput,
  GitHubProspectSearchResult
} from '../shared/publicProspects';
import {
  OperationClient,
  type FetchLike
} from './operationClient';
import { actorContextForRole } from './actorContext';

export type GitHubProspectsFetchLike = FetchLike;

export interface GitHubProspectsClientOptions {
  baseUrl?: string;
  fetcher?: GitHubProspectsFetchLike;
  actorContext?: ActorContext | (() => ActorContext);
  refreshState?: () => Promise<unknown>;
}

/**
 * Compatibility error for callers that used the former public-prospect
 * client. The request itself now goes through the canonical operation route.
 */
export class GitHubProspectsClientError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'GitHubProspectsClientError';
    this.status = status;
    this.payload = payload;
  }

  get isRateLimited(): boolean {
    if (this.status === 429) return true;
    if (typeof this.payload !== 'object' || this.payload === null) return false;
    const error = (this.payload as { error?: { code?: unknown; details?: unknown } }).error;
    if (error?.code === 'RATE_LIMITED_ERROR') return true;
    return (
      typeof error?.details === 'object' &&
      error.details !== null &&
      (error.details as { upstreamCode?: unknown }).upstreamCode === 'RATE_LIMITED'
    );
  }
}

function resolveActor(
  configured: GitHubProspectsClientOptions['actorContext']
): ActorContext {
  if (typeof configured === 'function') return { ...configured() };
  if (configured) return { ...configured };
  return actorContextForRole('recruiter');
}

function assertResult(body: unknown): GitHubProspectSearchResult {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { prospects?: unknown }).prospects) ||
    typeof (body as { query?: unknown }).query !== 'string' ||
    (body as { source?: unknown }).source !== 'github' ||
    typeof (body as { cache?: unknown }).cache !== 'object'
  ) {
    throw new GitHubProspectsClientError(
      502,
      'GitHub public-prospect service returned an invalid response',
      body
    );
  }
  return body as GitHubProspectSearchResult;
}

/**
 * Browser-side compatibility facade. It has no access to server credentials
 * and delegates to OperationClient, which owns the canonical operation request
 * and authoritative shared-state refresh.
 */
export class GitHubProspectsClient {
  private readonly operationClient: OperationClient;
  private readonly configuredActor?: GitHubProspectsClientOptions['actorContext'];

  constructor(options: GitHubProspectsClientOptions = {}) {
    this.operationClient = new OperationClient({
      baseUrl: options.baseUrl,
      fetcher: options.fetcher,
      actorContext: options.actorContext,
      refreshState: options.refreshState
    });
    this.configuredActor = options.actorContext;
  }

  async search(
    input: GitHubProspectSearchInput,
    signal?: AbortSignal
  ): Promise<GitHubProspectSearchResult> {
    try {
      const result = await this.operationClient.invoke(
        'search_public_candidates',
        input,
        resolveActor(this.configuredActor),
        signal
      );
      return assertResult(result);
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      const payload: PipelineErrorPayload = pipelineError.toPayload();
      throw new GitHubProspectsClientError(
        pipelineError.status,
        pipelineError.message,
        payload
      );
    }
  }

  getProspects = this.search.bind(this);
}

export function createGitHubProspectsClient(
  options: GitHubProspectsClientOptions = {}
): GitHubProspectsClient {
  return new GitHubProspectsClient(options);
}

export const githubProspectsClient = new GitHubProspectsClient();
export const gitHubProspectsClient = githubProspectsClient;
