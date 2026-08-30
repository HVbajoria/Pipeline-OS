import type { ActorContext } from '../shared/models';
import {
  InternalError,
  PipelineError,
  type PipelineErrorPayload
} from '../shared/errors';
import {
  getOperationDescriptor,
  isOperationName,
  type OperationInput,
  type OperationName,
  type OperationOutput
} from '../shared/operations';
import { refreshSharedState } from './synchronization';
import {
  DEFAULT_HUMAN_CONTEXT,
  type ActorContextProvider,
  actorContextForRole,
  type HumanRole
} from './actorContext';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface OperationClientOptions {
  baseUrl?: string;
  fetcher?: FetchLike;
  actorContext?: ActorContext | (() => ActorContext);
  refreshState?: () => Promise<unknown>;
}

function resolveActor(
  actor: ActorContext | undefined,
  configured: OperationClientOptions['actorContext']
): ActorContext {
  if (actor) return { ...actor };
  if (typeof configured === 'function') return { ...configured() };
  if (configured) return { ...configured };
  return { ...DEFAULT_HUMAN_CONTEXT };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFromResponse(response: Response, body: unknown): PipelineError {
  if (body && typeof body === 'object' && 'error' in body) {
    return PipelineError.from(body as PipelineErrorPayload);
  }

  return new InternalError(
    response.status >= 500
      ? 'Internal server error'
      : 'Operation request failed',
    { status: response.status }
  );
}

/**
 * Browser-side boundary shared by UI handlers and WebMCP execute callbacks.
 * It intentionally has no optimistic state methods: the server response is
 * followed by one authoritative `/api/state` refresh before the promise
 * resolves.
 */
export class OperationClient {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly configuredActor?: OperationClientOptions['actorContext'];
  private readonly refreshState: () => Promise<unknown>;

  constructor(options: OperationClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    const browserFetch = globalThis.fetch;
    if (!options.fetcher && typeof browserFetch !== 'function') {
      throw new Error('OperationClient requires a fetch implementation');
    }
    this.fetcher = options.fetcher ?? browserFetch.bind(globalThis);
    this.configuredActor = options.actorContext;
    this.refreshState = options.refreshState ?? refreshSharedState;
  }

  /** Make a client for a fixed human role without changing shared state. */
  forRole(role: HumanRole): OperationClient {
    return new OperationClient({
      baseUrl: this.baseUrl,
      fetcher: this.fetcher,
      actorContext: actorContextForRole(role),
      refreshState: this.refreshState
    });
  }

  async invoke<N extends OperationName>(
    name: N,
    input: OperationInput<N>,
    actor?: ActorContext,
    signal?: AbortSignal
  ): Promise<OperationOutput<N>> {
    if (!isOperationName(name)) {
      throw new InternalError(`Unknown operation: ${String(name)}`);
    }

    // Touching the descriptor makes the shared registry the single source of
    // the client contract as well as the server validator/WebMCP schema.
    getOperationDescriptor(name);
    const resolvedActor = resolveActor(actor, this.configuredActor);
    const requestBody = JSON.stringify({ input });
    let result: OperationOutput<N> | undefined;
    let failure: unknown;

    try {
      const response = await this.fetcher(
        `${this.baseUrl}/api/operations/${name}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-actor-type': resolvedActor.actorType,
            'x-actor-id': resolvedActor.actorId
          },
          body: requestBody,
          signal
        }
      );
      const body = await responseBody(response);
      if (!response.ok) {
        throw errorFromResponse(response, body);
      }
      if (body === undefined || body === null || typeof body !== 'object') {
        throw new InternalError(`Operation ${name} returned an invalid response`);
      }
      result = body as OperationOutput<N>;
    } catch (error) {
      failure = PipelineError.from(error);
    }

    // Refresh for both success and failure so failed activity entries are
    // visible to every open view. Preserve the operation error if both calls
    // fail; a successful operation cannot resolve with stale client state.
    try {
      await this.refreshState();
    } catch (refreshError) {
      if (failure === undefined) failure = refreshError;
    }

    if (failure !== undefined) throw failure;
    return result as OperationOutput<N>;
  }

  /** Convenience method for callers that keep the current role separately. */
  async invokeAsRole<N extends OperationName>(
    role: HumanRole,
    name: N,
    input: OperationInput<N>,
    signal?: AbortSignal
  ): Promise<OperationOutput<N>> {
    return this.invoke(name, input, actorContextForRole(role), signal);
  }
}

export function createOperationClient(
  options: OperationClientOptions = {}
): OperationClient {
  return new OperationClient(options);
}

export const operationClient = new OperationClient();
export const sharedOperationClient = operationClient;

// Keep this type alias available to integrations that used the provider name
// before the provider became a standalone module.
export type { ActorContextProvider };
