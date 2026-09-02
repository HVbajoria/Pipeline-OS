import type { ActorContext, InvocationMetadata } from '../shared/models';
import {
  InternalError,
  PipelineError,
  type PipelineErrorPayload
} from '../shared/errors';
import {
  getOperationDescriptor,
  isOperationName,
  type DiscoverCapabilitiesOutput,
  type OperationInput,
  type OperationName,
  type OperationOutput
} from '../shared/operations';
import { refreshSharedState } from './synchronization';
import {
  DEFAULT_HUMAN_CONTEXT,
  resolveActorContextSource,
  type ActorContextSource,
  type ActorContextProvider,
  actorContextForRole,
  type HumanRole
} from './actorContext';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface OperationInvokeOptions {
  /** Optional per-invocation actor; configured client actor remains the fallback. */
  actor?: ActorContext;
  /** Additive alias used by callers that name the field after the context source. */
  actorContext?: ActorContext;
  metadata?: InvocationMetadata;
  signal?: AbortSignal;
}

export interface OperationResponseMetadata {
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  replayed?: boolean;
  originalActivityId?: string;
}

export interface OperationClientOptions {
  baseUrl?: string;
  fetcher?: FetchLike;
  actorContext?: ActorContextSource;
  refreshState?: (actor?: ActorContext) => Promise<unknown>;
  onResponseMetadata?: (metadata: OperationResponseMetadata) => void;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isActorContext(value: unknown): value is ActorContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'actorType' in value &&
    'actorId' in value &&
    (value.actorType === 'human_ui' || value.actorType === 'agent') &&
    typeof value.actorId === 'string'
  );
}

function resolveActor(
  actor: ActorContext | undefined,
  configured: OperationClientOptions['actorContext']
): ActorContext {
  return resolveActorContextSource(actor ?? configured, DEFAULT_HUMAN_CONTEXT);
}

function generatedIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `client-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function responseMetadata(response: Response): OperationResponseMetadata {
  const correlationId = response.headers.get('x-correlation-id') ?? undefined;
  const traceId = response.headers.get('x-trace-id') ?? undefined;
  const spanId = response.headers.get('x-span-id') ?? undefined;
  const parentSpanId = response.headers.get('x-parent-span-id') ?? undefined;
  const replayed = response.headers.get('x-idempotency-replayed') === 'true';
  const originalActivityId =
    response.headers.get('x-idempotency-original-activity-id') ?? undefined;
  return {
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(replayed ? { replayed: true } : {}),
    ...(originalActivityId === undefined ? {} : { originalActivityId })
  };
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

type InvokeArguments = {
  actor?: ActorContext;
  metadata?: InvocationMetadata;
  signal?: AbortSignal;
  /** True only for the additive options overload, not the legacy actor form. */
  optionsObject: boolean;
};

function resolveInvokeArguments(
  actorOrOptions: ActorContext | OperationInvokeOptions | undefined,
  signal: AbortSignal | undefined
): InvokeArguments {
  if (isActorContext(actorOrOptions)) {
    return { actor: actorOrOptions, signal, optionsObject: false };
  }

  const options = actorOrOptions ?? {};
  return {
    actor: options.actor ?? options.actorContext,
    metadata: options.metadata,
    signal: options.signal ?? signal,
    optionsObject: actorOrOptions !== undefined
  };
}

function invocationMetadata(
  metadata: InvocationMetadata | undefined,
  generateIdempotencyKey: boolean,
  executionClass: string
): InvocationMetadata | undefined {
  if (!generateIdempotencyKey || executionClass === 'read') {
    return metadata === undefined ? undefined : { ...metadata };
  }

  const result: InvocationMetadata = { ...(metadata ?? {}) };
  if (result.idempotencyKey === undefined) {
    result.idempotencyKey = generatedIdempotencyKey();
  }
  return result;
}

function transportHeaders(
  actor: ActorContext,
  metadata: InvocationMetadata | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-actor-type': actor.actorType,
    'x-actor-id': actor.actorId
  };
  if (metadata?.correlationId !== undefined && typeof metadata.correlationId === 'string') {
    headers['x-correlation-id'] = metadata.correlationId;
  }
  if (metadata?.idempotencyKey !== undefined && typeof metadata.idempotencyKey === 'string') {
    headers['idempotency-key'] = metadata.idempotencyKey;
  }
  if (metadata?.expectedRevision !== undefined && typeof metadata.expectedRevision === 'number') {
    headers['if-match'] = `revision-${metadata.expectedRevision}`;
  }
  if (metadata?.approvalId !== undefined && typeof metadata.approvalId === 'string') {
    headers['x-approval-id'] = metadata.approvalId;
  }
  if (metadata?.parentSpanId !== undefined && typeof metadata.parentSpanId === 'string') {
    headers['x-parent-span-id'] = metadata.parentSpanId;
  }
  return headers;
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
  private readonly refreshState: (actor?: ActorContext) => Promise<unknown>;
  private readonly onResponseMetadata?: OperationClientOptions['onResponseMetadata'];
  private lastResponseMetadata: OperationResponseMetadata = {};

  constructor(options: OperationClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? '');
    const browserFetch = globalThis.fetch;
    if (!options.fetcher && typeof browserFetch !== 'function') {
      throw new Error('OperationClient requires a fetch implementation');
    }
    this.fetcher = options.fetcher ?? browserFetch.bind(globalThis);
    this.configuredActor = options.actorContext;
    this.onResponseMetadata = options.onResponseMetadata;
    this.refreshState =
      options.refreshState ??
      ((actor?: ActorContext) =>
        refreshSharedState({
          baseUrl: this.baseUrl,
          fetcher: this.fetcher,
          actorContext: actor
        }));
  }

  /** Make a client for a fixed human role without changing shared state. */
  forRole(role: HumanRole): OperationClient {
    return new OperationClient({
      baseUrl: this.baseUrl,
      fetcher: this.fetcher,
      actorContext: actorContextForRole(role),
      refreshState: this.refreshState,
      onResponseMetadata: this.onResponseMetadata
    });
  }

  /** Transport metadata from the most recent operation response. */
  getLastResponseMetadata(): OperationResponseMetadata {
    return { ...this.lastResponseMetadata };
  }

  async invoke<N extends OperationName>(
    name: N,
    input: OperationInput<N>,
    actor?: ActorContext,
    signal?: AbortSignal
  ): Promise<OperationOutput<N>>;
  async invoke<N extends OperationName>(
    name: N,
    input: OperationInput<N>,
    options?: OperationInvokeOptions
  ): Promise<OperationOutput<N>>;
  async invoke<N extends OperationName>(
    name: N,
    input: OperationInput<N>,
    actorOrOptions?: ActorContext | OperationInvokeOptions,
    signal?: AbortSignal
  ): Promise<OperationOutput<N>> {
    if (!isOperationName(name)) {
      throw new InternalError(`Unknown operation: ${String(name)}`);
    }

    // Touching the descriptor makes the shared registry the single source of
    // the client contract as well as the server validator/WebMCP schema.
    const descriptor = getOperationDescriptor(name);
    const args = resolveInvokeArguments(actorOrOptions, signal);
    const resolvedActor = resolveActor(args.actor, this.configuredActor);
    const metadata = invocationMetadata(
      args.metadata,
      args.optionsObject,
      descriptor.executionClass
    );
    const requestBody: { input: OperationInput<N>; metadata?: InvocationMetadata } = {
      input,
      ...(metadata === undefined ? {} : { metadata })
    };
    const requestInit: RequestInit = {
      method: 'POST',
      headers: transportHeaders(resolvedActor, metadata),
      body: JSON.stringify(requestBody),
      signal: args.signal
    };

    let result: OperationOutput<N> | undefined;
    let failure: unknown;
    this.lastResponseMetadata = {};

    try {
      const response = await this.fetcher(
        `${this.baseUrl}/api/operations/${name}`,
        requestInit
      );
      const metadataFromResponse = responseMetadata(response);
      this.lastResponseMetadata = metadataFromResponse;
      try {
        this.onResponseMetadata?.(metadataFromResponse);
      } catch {
        // Response observers are diagnostic hooks and must not change the
        // operation output/error contract.
      }
      const body = await responseBody(response);
      if (!response.ok) {
        throw errorFromResponse(response, body);
      }
      if (body === undefined || body === null || typeof body !== 'object') {
        throw new InternalError(`Operation ${name} returned an invalid response`);
      }
      if ('error' in body) {
        throw PipelineError.from(body as PipelineErrorPayload);
      }
      result = body as OperationOutput<N>;
    } catch (error) {
      failure = PipelineError.from(error);
    }

    // Refresh for both success and failure so failed activity entries are
    // visible to every open view. Preserve the operation error if both calls
    // fail; a successful operation cannot resolve with stale client state.
    try {
      await this.refreshState(resolvedActor);
    } catch (refreshError) {
      if (failure === undefined) failure = PipelineError.from(refreshError);
    }

    if (failure !== undefined) throw failure;
    return result as OperationOutput<N>;
  }

  /** Discover the current actor's policy projection through the canonical read path. */
  async discoverCapabilities(actor?: ActorContext): Promise<DiscoverCapabilitiesOutput> {
    if (actor === undefined) {
      return this.invoke('discover_capabilities', {});
    }
    return this.invoke('discover_capabilities', {}, { actor });
  }

  /** Convenience method for callers that keep the current role separately. */
  async invokeAsRole<N extends OperationName>(
    role: HumanRole,
    name: N,
    input: OperationInput<N>,
    signal?: AbortSignal
  ): Promise<OperationOutput<N>> {
    return this.invoke(name, input, {
      actor: actorContextForRole(role),
      signal
    });
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
