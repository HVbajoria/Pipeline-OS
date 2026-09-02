import { PipelineError, type PipelineErrorPayload } from '../shared/errors';
import type { ActorContext, SharedStateProjectionWithCatalogs } from '../shared/models';
import { useStore } from '../lib/store';
import {
  DEFAULT_HUMAN_CONTEXT,
  resolveActorContextSource,
  actorContextForRole,
  type ActorContextSource
} from './actorContext';

export type StateFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface SynchronizationOptions {
  baseUrl?: string;
  fetcher?: StateFetch;
  actorContext?: ActorContextSource;
  /** Additive singular alias for hosts that call the current actor `actor`. */
  actor?: ActorContext;
  eventSourceFactory?: (url: string) => RevisionEventSource;
}

export interface RevisionEventSource {
  onmessage?: ((event: MessageEvent<string>) => void) | null;
  onerror?: ((event: Event) => void) | null;
  addEventListener?: (
    type: string,
    listener: (event: MessageEvent<string>) => void
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event: MessageEvent<string>) => void
  ) => void;
  close: () => void;
}

function defaultFetcher(): StateFetch {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('State synchronization requires a fetch implementation');
  }
  return globalThis.fetch.bind(globalThis);
}

function resolveSynchronizationActor(options: Pick<SynchronizationOptions, 'actorContext' | 'actor'>): ActorContext {
  return resolveActorContextSource(
    options.actorContext ?? options.actor,
    DEFAULT_HUMAN_CONTEXT
  );
}

function actorHeaders(actor: ActorContext): Record<string, string> {
  return {
    accept: 'application/json',
    'x-actor-type': actor.actorType,
    'x-actor-id': actor.actorId
  };
}

function actorEventUrl(baseUrl: string, actor: ActorContext): string {
  const url = `${baseUrl ?? ''}/api/events`;
  const query = new URLSearchParams({
    actorType: actor.actorType,
    actorId: actor.actorId
  }).toString();
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function fetchProjection(
  options: Pick<
    SynchronizationOptions,
    'baseUrl' | 'fetcher' | 'actorContext' | 'actor'
  > = {}
): Promise<SharedStateProjectionWithCatalogs> {
  const fetcher = options.fetcher ?? defaultFetcher();
  const actor = resolveSynchronizationActor(options);
  const response = await fetcher(`${options.baseUrl ?? ''}/api/state`, {
    method: 'GET',
    headers: actorHeaders(actor)
  });
  const body = await parseBody(response);
  if (!response.ok) {
    throw PipelineError.from(body as PipelineErrorPayload);
  }
  if (!body || typeof body !== 'object') {
    throw new Error('State endpoint returned an invalid projection');
  }
  return body as SharedStateProjectionWithCatalogs;
}

/**
 * Install an authoritative projection only when it is not older than the
 * snapshot already visible to the current view. Equal revisions are accepted
 * because an actor switch can legitimately return a different projection at
 * the same repository revision.
 */
function hydrateIfCurrentOrNewer(
  projection: SharedStateProjectionWithCatalogs
): boolean {
  if (projection.revision < useStore.getState().revision) return false;
  useStore.getState().hydrate(projection);
  return true;
}

/** Fetch and install one immutable server projection into Zustand. */
export async function refreshSharedState(
  options: Pick<
    SynchronizationOptions,
    'baseUrl' | 'fetcher' | 'actorContext' | 'actor'
  > = {}
): Promise<SharedStateProjectionWithCatalogs> {
  const projection = await fetchProjection(options);
  hydrateIfCurrentOrNewer(projection);
  return projection;
}

function revisionFromEvent(event: MessageEvent<string> | { data?: unknown }): number {
  const value = typeof event.data === 'string' ? safeJson(event.data) : event.data;
  if (!value || typeof value !== 'object' || !('revision' in value)) return 0;
  const revision = (value as { revision?: unknown }).revision;
  return typeof revision === 'number' && Number.isInteger(revision)
    ? revision
    : 0;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Coordinates initial hydration and revision-only SSE notifications. Multiple
 * revisions arriving while a state request is in flight collapse into one
 * follow-up request, so every view receives the same latest snapshot.
 */
export class SynchronizationController {
  private readonly options: SynchronizationOptions;
  private source: RevisionEventSource | null = null;
  private stopped = true;
  private queuedRevision = 0;
  private drainPromise: Promise<void> | null = null;
  private startPromise: Promise<SharedStateProjectionWithCatalogs> | null = null;
  private generation = 0;
  private readonly eventHandler = (event: MessageEvent<string>) => {
    this.queueRevision(revisionFromEvent(event));
  };

  constructor(options: SynchronizationOptions = {}) {
    this.options = options;
  }

  async start(): Promise<SharedStateProjectionWithCatalogs> {
    if (this.startPromise) return this.startPromise;
    if (!this.stopped) {
      return useStore.getState().snapshot();
    }

    this.stopped = false;
    const generation = ++this.generation;
    let startup: Promise<SharedStateProjectionWithCatalogs>;
    startup = fetchProjection(this.options)
      .then((projection) => {
        // A StrictMode cleanup or an explicit stop may have happened while
        // the initial request was in flight. Do not hydrate or reconnect a
        // controller that is no longer the active lifecycle instance.
        if (this.isCurrent(generation)) {
          // `start()` establishes a new view lifecycle. Its initial snapshot
          // is authoritative even when a previous test/view left the shared
          // client store at a higher revision; monotonic protection remains
          // in force for subsequent refreshes and SSE drains.
          useStore.getState().hydrate(projection);
          this.connectEvents();
        }
        return projection;
      })
      .catch((error) => {
        if (this.isCurrent(generation)) {
          this.stopped = true;
          this.queuedRevision = 0;
        }
        throw error;
      })
      .finally(() => {
        if (this.startPromise === startup) this.startPromise = null;
      });
    this.startPromise = startup;
    return startup;
  }

  async refreshForActorChange(): Promise<void> {
    if (this.stopped) return;
    this.stop();
    await this.start().then(() => undefined);
  }

  async refresh(): Promise<SharedStateProjectionWithCatalogs> {
    return refreshSharedState(this.options);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.queuedRevision = 0;
    // An in-flight drain checks its captured generation before installing a
    // projection. Clear the handle so a subsequent start can schedule its own
    // drain without being blocked by the old request.
    this.drainPromise = null;
    this.startPromise = null;
    if (this.source) {
      if (this.source.removeEventListener) {
        this.source.removeEventListener('state_changed', this.eventHandler);
      } else {
        this.source.onmessage = null;
      }
      this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private connectEvents(): void {
    if (this.stopped || this.source) return;
    const factory =
      this.options.eventSourceFactory ??
      (typeof globalThis.EventSource === 'function'
        ? (url: string) => new globalThis.EventSource(url)
        : undefined);
    if (!factory) return;

    const actor = resolveSynchronizationActor(this.options);
    this.source = factory(actorEventUrl(this.options.baseUrl ?? '', actor));
    if (this.source.addEventListener) {
      this.source.addEventListener('state_changed', this.eventHandler);
    } else {
      this.source.onmessage = this.eventHandler;
    }
  }

  private queueRevision(revision: number): void {
    if (
      this.stopped ||
      !Number.isInteger(revision) ||
      revision <= useStore.getState().revision
    ) {
      return;
    }
    this.queuedRevision = Math.max(this.queuedRevision, revision);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainPromise || this.stopped) return;
    const generation = this.generation;
    const drain = this.drain(generation).catch(() => {
      // Keep the requested revision queued. A subsequent SSE notification can
      // retry a transient state request without turning an event callback into
      // an unhandled rejection.
    });
    let tracked: Promise<void>;
    tracked = drain.finally(() => {
      if (this.drainPromise === tracked) this.drainPromise = null;
    });
    this.drainPromise = tracked;
  }

  private async drain(generation: number): Promise<void> {
    while (this.isCurrent(generation)) {
      const requestedRevision = this.queuedRevision;
      const currentRevision = useStore.getState().revision;
      if (requestedRevision <= currentRevision) {
        this.queuedRevision = 0;
        return;
      }

      const projection = await fetchProjection(this.options);
      if (!this.isCurrent(generation)) return;

      // A concurrent operation-client refresh can install a newer snapshot;
      // never let an older SSE-triggered response regress the store.
      hydrateIfCurrentOrNewer(projection);

      const observedRevision = useStore.getState().revision;
      if (this.queuedRevision <= observedRevision) {
        this.queuedRevision = 0;
        return;
      }
      // The server returned a snapshot older than the revision announced by
      // SSE. Keep the target queued and request again until the same snapshot
      // boundary is visible to every view.
    }
  }
}

export function createSynchronizationController(
  options: SynchronizationOptions = {}
): SynchronizationController {
  return new SynchronizationController(options);
}

export const synchronizationController = new SynchronizationController({
  // Resolve the current UI role for every authoritative state refresh. The
  // EventSource itself remains revision-only; actor identity is carried in
  // the initial query while each `/api/state` request gets fresh headers.
  actorContext: () => actorContextForRole(useStore.getState().currentRole)
});

// Role changes alter the actor-scoped projection. Invalidate any in-flight
// response and reconnect the revision-only stream under the new actor.
useStore.subscribe((state, previous) => {
  if (state.currentRole === previous.currentRole) return;
  void synchronizationController.refreshForActorChange().catch(() => undefined);
});
