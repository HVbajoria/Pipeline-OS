import { PipelineError, type PipelineErrorPayload } from '../shared/errors';
import type { SharedStateProjectionWithCatalogs } from '../shared/models';
import { useStore } from '../lib/store';

export type StateFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface SynchronizationOptions {
  baseUrl?: string;
  fetcher?: StateFetch;
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
  options: Pick<SynchronizationOptions, 'baseUrl' | 'fetcher'> = {}
): Promise<SharedStateProjectionWithCatalogs> {
  const fetcher = options.fetcher ?? defaultFetcher();
  const response = await fetcher(`${options.baseUrl ?? ''}/api/state`, {
    method: 'GET',
    headers: { accept: 'application/json' }
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

/** Fetch and install one immutable server projection into Zustand. */
export async function refreshSharedState(
  options: Pick<SynchronizationOptions, 'baseUrl' | 'fetcher'> = {}
): Promise<SharedStateProjectionWithCatalogs> {
  const projection = await fetchProjection(options);
  useStore.getState().hydrate(projection);
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
  private readonly eventHandler = (event: MessageEvent<string>) => {
    this.queueRevision(revisionFromEvent(event));
  };

  constructor(options: SynchronizationOptions = {}) {
    this.options = options;
  }

  async start(): Promise<SharedStateProjectionWithCatalogs> {
    if (!this.stopped) {
      return useStore.getState().snapshot();
    }
    this.stopped = false;
    const projection = await refreshSharedState(this.options);
    this.connectEvents();
    return projection;
  }

  async refresh(): Promise<SharedStateProjectionWithCatalogs> {
    return refreshSharedState(this.options);
  }

  stop(): void {
    this.stopped = true;
    this.queuedRevision = 0;
    if (this.source) {
      if (this.source.removeEventListener) {
        this.source.removeEventListener('state_changed', this.eventHandler);
      }
      this.source.close();
      this.source = null;
    }
  }

  private connectEvents(): void {
    if (this.stopped || this.source) return;
    const factory =
      this.options.eventSourceFactory ??
      (typeof globalThis.EventSource === 'function'
        ? (url: string) => new globalThis.EventSource(url)
        : undefined);
    if (!factory) return;

    this.source = factory(`${this.options.baseUrl ?? ''}/api/events`);
    if (this.source.addEventListener) {
      this.source.addEventListener('state_changed', this.eventHandler);
    } else {
      this.source.onmessage = this.eventHandler;
    }
  }

  private queueRevision(revision: number): void {
    if (this.stopped || revision <= useStore.getState().revision) return;
    this.queuedRevision = Math.max(this.queuedRevision, revision);
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
        if (!this.stopped && this.queuedRevision > useStore.getState().revision) {
          this.queueRevision(this.queuedRevision);
        }
      });
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queuedRevision > useStore.getState().revision) {
      this.queuedRevision = 0;
      await refreshSharedState(this.options);
    }
  }
}

export function createSynchronizationController(
  options: SynchronizationOptions = {}
): SynchronizationController {
  return new SynchronizationController(options);
}

export const synchronizationController = new SynchronizationController();
