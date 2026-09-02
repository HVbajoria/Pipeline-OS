import {
  createServer,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createPipelineApi,
  type PipelineApi,
  type PipelineApiOptions
} from '../src/server/api';
import type { ActorContext, SharedStateProjectionWithCatalogs } from '../src/shared/models';
import { createAuthorizationPolicy, createTrustedActorResolver } from '../src/server/authorization';
import { defaultOperationHandlers } from '../src/server/operations';
import { createTestContext, DeterministicIdGenerator, TEST_TIMESTAMP } from './factories';
import { serializeSharedState } from '../src/server/api';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import { actorContextForAgent, actorContextForRole } from '../src/client/actorContext';
import { OperationClient, type FetchLike, type OperationResponseMetadata } from '../src/client/operationClient';
import {
  refreshSharedState,
  SynchronizationController
} from '../src/client/synchronization';
import { useStore } from '../src/lib/store';

const recruiter = actorContextForRole('recruiter');
const candidate = actorContextForRole('candidate');
const agent = actorContextForAgent('agent-p12-2');

interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown;
}

interface RunningApi {
  api: PipelineApi;
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

function actorHeaders(actor: ActorContext): Record<string, string> {
  return {
    'x-actor-type': actor.actorType,
    'x-actor-id': actor.actorId
  };
}

async function readHttpResult(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = text;
  if (text.length === 0) body = undefined;
  else {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Preserve an unexpected non-JSON response for the assertion.
    }
  }
  return { status: response.status, headers: response.headers, body };
}

async function requestJson(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return readHttpResult(response);
}

async function startApi(options: PipelineApiOptions = {}): Promise<RunningApi> {
  const api = createPipelineApi({
    repository:
      options.repository ??
      createTestContext({
        timestamp: TEST_TIMESTAMP,
        idGenerator: new DeterministicIdGenerator('p12-2', 100)
      }).repository,
    handlers: options.handlers ?? defaultOperationHandlers,
    ...options
  });
  const server = createServer(api.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    api,
    baseUrl,
    server,
    async close(): Promise<void> {
      api.events.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

function projectionForActor(actorId: string): SharedStateProjectionWithCatalogs {
  const projection = serializeSharedState(
    new SharedStateRepository(createSeed()).read()
  );
  return {
    ...projection,
    activityLog: [
      {
        id: `activity-${actorId}`,
        toolName: 'search_candidates',
        actorType: actorId.startsWith('agent') ? 'agent' : 'human_ui',
        actorId,
        input: {},
        output: { results: [] },
        timestamp: TEST_TIMESTAMP
      }
    ]
  };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  });
}

describe('P12.2 HTTP metadata and route authorization', () => {
  it('keeps metadata outside operation input and returns correlation/replay headers', async () => {
    const context = createTestContext({
      timestamp: TEST_TIMESTAMP,
      idGenerator: new DeterministicIdGenerator('http-p12-2', 100)
    });
    const running = await startApi({ repository: context.repository });

    try {
      const metadata = {
        correlationId: 'correlation-http-1',
        idempotencyKey: 'idempotency-http-1',
        expectedRevision: 0,
        approvalId: 'approval-http-1',
        parentSpanId: 'parent-http-1'
      };
      const first = await requestJson(
        running.baseUrl,
        '/api/operations/search_candidates',
        'POST',
        { input: { query: 'backend' }, metadata },
        {
          ...actorHeaders({ actorType: 'human_ui', actorId: 'http-human' }),
          'x-correlation-id': metadata.correlationId,
          'idempotency-key': metadata.idempotencyKey,
          'if-match': 'revision-0',
          'x-approval-id': metadata.approvalId,
          'x-parent-span-id': metadata.parentSpanId
        }
      );

      expect(first.status).toBe(200);
      expect(first.body).toEqual(expect.objectContaining({ results: expect.any(Array) }));
      expect(first.headers.get('x-correlation-id')).toBe(metadata.correlationId);
      expect(first.headers.get('x-idempotency-replayed')).toBeNull();

      const stateAfterFirst = await requestJson(
        running.baseUrl,
        '/api/state',
        'GET',
        undefined,
        actorHeaders({ actorType: 'human_ui', actorId: 'http-human' })
      );
      const firstActivity = (stateAfterFirst.body as SharedStateProjectionWithCatalogs)
        .activityLog.at(-1);
      expect(firstActivity).toMatchObject({
        toolName: 'search_candidates',
        actorId: 'http-human',
        input: { query: 'backend' },
        correlationId: metadata.correlationId,
        parentSpanId: metadata.parentSpanId
      });
      expect(firstActivity?.input).not.toHaveProperty('metadata');
      expect(JSON.stringify(firstActivity?.input)).not.toContain(metadata.idempotencyKey);

      const replayMetadata = {
        ...metadata,
        correlationId: 'correlation-http-replay',
        parentSpanId: 'parent-http-replay'
      };
      const replay = await requestJson(
        running.baseUrl,
        '/api/operations/search_candidates',
        'POST',
        { input: { query: 'backend' }, metadata: replayMetadata },
        {
          ...actorHeaders({ actorType: 'human_ui', actorId: 'http-human' }),
          'x-correlation-id': replayMetadata.correlationId,
          'idempotency-key': replayMetadata.idempotencyKey,
          'if-match': 'revision-0',
          'x-approval-id': replayMetadata.approvalId,
          'x-parent-span-id': replayMetadata.parentSpanId
        }
      );

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.get('x-correlation-id')).toBe(replayMetadata.correlationId);
      expect(replay.headers.get('x-idempotency-replayed')).toBe('true');
      expect(replay.headers.get('x-idempotency-original-activity-id')).toBe(
        firstActivity?.id
      );

      const mismatch = await requestJson(
        running.baseUrl,
        '/api/operations/search_candidates',
        'POST',
        {
          input: { query: 'backend' },
          metadata: { correlationId: 'body-correlation' }
        },
        {
          ...actorHeaders({ actorType: 'human_ui', actorId: 'http-human' }),
          'x-correlation-id': 'header-correlation'
        }
      );
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          details: { reason: 'metadata_invalid', field: 'metadata.correlationId' }
        }
      });
      const stateAfterMismatch = await requestJson(
        running.baseUrl,
        '/api/state',
        'GET',
        undefined,
        actorHeaders({ actorType: 'human_ui', actorId: 'http-human' })
      );
      expect((stateAfterMismatch.body as SharedStateProjectionWithCatalogs).activityLog).toHaveLength(2);
    } finally {
      await running.close();
    }
  });

  it('returns a safe structured metadata error for an invalid correlation value', async () => {
    const context = createTestContext({
      timestamp: TEST_TIMESTAMP,
      idGenerator: new DeterministicIdGenerator('invalid-correlation-p12-2', 100)
    });
    const running = await startApi({ repository: context.repository });

    try {
      const result = await requestJson(
        running.baseUrl,
        '/api/operations/search_candidates',
        'POST',
        {
          input: { query: 'backend' },
          metadata: { correlationId: 'invalid\ncorrelation' }
        },
        actorHeaders({ actorType: 'human_ui', actorId: 'http-human' })
      );

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          details: {
            field: 'metadata.correlationId',
            reason: 'metadata_invalid'
          }
        }
      });
      expect(result.headers.get('x-correlation-id')).toMatch(
        /^correlation-[0-9a-f-]{36}$/u
      );
      expect(running.api.repository.read().activityLog).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it('keeps compatibility aliases on the same metadata-separated operation path', async () => {
    const context = createTestContext({
      timestamp: TEST_TIMESTAMP,
      idGenerator: new DeterministicIdGenerator('alias-p12-2', 100)
    });
    const running = await startApi({ repository: context.repository });

    try {
      const result = await requestJson(
        running.baseUrl,
        '/api/jobs',
        'POST',
        {
          title: 'Legacy alias role',
          department: 'Engineering',
          requirements: ['TypeScript'],
          compBand: { min: 100, max: 120, currency: 'USD' },
          metadata: {
            correlationId: 'correlation-alias',
            idempotencyKey: 'idempotency-alias'
          }
        },
        {
          ...actorHeaders({ actorType: 'human_ui', actorId: 'http-human' }),
          'x-correlation-id': 'correlation-alias',
          'idempotency-key': 'idempotency-alias'
        }
      );
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ jobId: expect.stringMatching(/^job-/) });
      expect(result.headers.get('x-correlation-id')).toBe('correlation-alias');

      const state = await requestJson(
        running.baseUrl,
        '/api/state',
        'GET',
        undefined,
        actorHeaders({ actorType: 'human_ui', actorId: 'http-human' })
      );
      const activity = (state.body as SharedStateProjectionWithCatalogs).activityLog.at(-1);
      expect(activity).toMatchObject({
        toolName: 'create_job_requisition',
        input: {
          title: 'Legacy alias role',
          department: 'Engineering'
        },
        correlationId: 'correlation-alias'
      });
      expect(activity?.input).not.toHaveProperty('metadata');
    } finally {
      await running.close();
    }
  });

  it('returns a correlated stale conflict without retrying or mutating domain records', async () => {
    const context = createTestContext({
      timestamp: TEST_TIMESTAMP,
      idGenerator: new DeterministicIdGenerator('stale-p12-2', 100)
    });
    const running = await startApi({ repository: context.repository });

    try {
      const result = await requestJson(
        running.baseUrl,
        '/api/operations/create_job_requisition',
        'POST',
        {
          input: {
            title: 'Stale HTTP role',
            department: 'Engineering',
            requirements: ['TypeScript'],
            compBand: { min: 100, max: 120, currency: 'USD' }
          }
        },
        {
          ...actorHeaders({ actorType: 'human_ui', actorId: 'http-human' }),
          'x-correlation-id': 'correlation-stale-http',
          'idempotency-key': 'idempotency-stale-http',
          'if-match': 'revision-99'
        }
      );
      expect(result.status).toBe(409);
      expect(result.headers.get('x-correlation-id')).toBe('correlation-stale-http');
      expect(result.body).toMatchObject({
        error: {
          code: 'CONFLICT_ERROR',
          details: {
            reason: 'stale_revision',
            expectedRevision: 99,
            currentRevision: 0
          }
        }
      });

      const state = await requestJson(
        running.baseUrl,
        '/api/state',
        'GET',
        undefined,
        actorHeaders({ actorType: 'human_ui', actorId: 'http-human' })
      );
      const projection = state.body as SharedStateProjectionWithCatalogs;
      expect(projection.jobs).toHaveLength(1);
      expect(projection.activityLog.at(-1)).toMatchObject({
        toolName: 'create_job_requisition',
        input: expect.objectContaining({ title: 'Stale HTTP role' }),
        correlationId: 'correlation-stale-http'
      });
    } finally {
      await running.close();
    }
  });

  it('authorizes state, reset, and events with the trusted actor rather than forged headers', async () => {
    const context = createTestContext({
      timestamp: TEST_TIMESTAMP,
      idGenerator: new DeterministicIdGenerator('auth-p12-2', 100)
    });
    const running = await startApi({
      repository: context.repository,
      environment: 'development',
      trustedActorResolver: createTrustedActorResolver({ environment: 'development' }),
      authorizationPolicy: createAuthorizationPolicy({ environment: 'development' }),
      stateProjectionHooks: {
        activityFilter: (entry, actor) => entry.actorId === actor?.actorId
      }
    });

    try {
      await expect(
        requestJson(
          running.baseUrl,
          '/api/operations/search_candidates',
          'POST',
          { input: { query: 'backend' } },
          actorHeaders(recruiter)
        )
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        requestJson(
          running.baseUrl,
          '/api/operations/get_candidate_profile',
          'POST',
          { input: { candidateId: 'cand-1' } },
          actorHeaders(candidate)
        )
      ).resolves.toMatchObject({ status: 200 });

      const candidateState = await requestJson(
        running.baseUrl,
        '/api/state',
        'GET',
        undefined,
        actorHeaders(candidate)
      );
      expect(candidateState.status).toBe(200);
      expect(
        (candidateState.body as SharedStateProjectionWithCatalogs).activityLog
      ).toEqual([expect.objectContaining({ actorId: candidate.actorId })]);

      const recruiterState = await requestJson(
        running.baseUrl,
        '/api/state',
        'GET',
        undefined,
        actorHeaders(recruiter)
      );
      expect(
        (recruiterState.body as SharedStateProjectionWithCatalogs).activityLog
      ).toEqual([expect.objectContaining({ actorId: recruiter.actorId })]);

      const deniedReset = await requestJson(
        running.baseUrl,
        '/api/reset',
        'POST',
        {},
        actorHeaders(candidate)
      );
      expect(deniedReset.status).toBe(403);

      const forgedEvents = await requestJson(
        running.baseUrl,
        '/api/events',
        'GET',
        undefined,
        actorHeaders({ actorType: 'human_ui', actorId: 'forged-user' })
      );
      expect(forgedEvents.status).toBe(403);
      expect(forgedEvents.body).toMatchObject({
        error: {
          code: 'FORBIDDEN_ERROR',
          details: { reason: 'not_authenticated' }
        }
      });

      const authorizedEventsResponse = await fetch(`${running.baseUrl}/api/events`, {
        headers: actorHeaders(recruiter)
      });
      expect(authorizedEventsResponse.status).toBe(200);
      await authorizedEventsResponse.body?.cancel();
    } finally {
      await running.close();
    }
  });
});

describe('P12.2 OperationClient and synchronization propagation', () => {
  it('sends additive metadata, captures replay headers, refreshes with the actor, and preserves legacy calls', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const refreshedActors: ActorContext[] = [];
    const observed: OperationResponseMetadata[] = [];
    const fetcher: FetchLike = async (request, init) => {
      calls.push({ url: String(request), init });
      return response(
        { results: [] },
        200,
        {
          'x-correlation-id': 'correlation-client-replay',
          'x-idempotency-replayed': 'true',
          'x-idempotency-original-activity-id': 'activity-original'
        }
      );
    };
    const client = new OperationClient({
      fetcher,
      actorContext: recruiter,
      refreshState: async (actor) => {
        if (actor !== undefined) refreshedActors.push(actor);
      },
      onResponseMetadata: (metadata) => observed.push(metadata)
    });

    const options = {
      actorContext: agent,
      metadata: {
        correlationId: 'correlation-client-request',
        idempotencyKey: 'idempotency-client',
        expectedRevision: 7,
        approvalId: 'approval-client',
        parentSpanId: 'parent-client'
      }
    };
    await expect(
      client.invoke('search_candidates', { query: 'backend' }, options)
    ).resolves.toEqual({ results: [] });

    const operationRequest = calls[0];
    expect(JSON.parse(String(operationRequest.init?.body))).toEqual({
      input: { query: 'backend' },
      metadata: options.metadata
    });
    const operationHeaders = new Headers(operationRequest.init?.headers);
    expect(operationHeaders.get('x-actor-id')).toBe(agent.actorId);
    expect(operationHeaders.get('x-correlation-id')).toBe(options.metadata.correlationId);
    expect(operationHeaders.get('idempotency-key')).toBe(options.metadata.idempotencyKey);
    expect(operationHeaders.get('if-match')).toBe('revision-7');
    expect(operationHeaders.get('x-approval-id')).toBe(options.metadata.approvalId);
    expect(operationHeaders.get('x-parent-span-id')).toBe(options.metadata.parentSpanId);
    expect(refreshedActors).toEqual([agent]);
    expect(observed).toEqual([
      {
        correlationId: 'correlation-client-replay',
        replayed: true,
        originalActivityId: 'activity-original'
      }
    ]);
    expect(client.getLastResponseMetadata()).toEqual(observed[0]);

    const controller = new AbortController();
    const legacy = new OperationClient({
      fetcher: async (_request, init) => {
        calls.push({ url: '/legacy', init });
        return response({ results: [] });
      },
      refreshState: async (actor) => {
        if (actor !== undefined) refreshedActors.push(actor);
      }
    });
    await expect(
      legacy.invoke(
        'search_candidates',
        { query: 'legacy' },
        recruiter,
        controller.signal
      )
    ).resolves.toEqual({ results: [] });
    const legacyRequest = calls.at(-1)!;
    expect(JSON.parse(String(legacyRequest.init?.body))).toEqual({
      input: { query: 'legacy' }
    });
    expect(new Headers(legacyRequest.init?.headers).get('idempotency-key')).toBeNull();
    expect(legacyRequest.init?.signal).toBe(controller.signal);
    expect(refreshedActors.at(-1)).toEqual(recruiter);
  });

  it('refreshes once after a stale failure and never retries the commit request', async () => {
    let operationCalls = 0;
    const refreshedActors: ActorContext[] = [];
    const client = new OperationClient({
      fetcher: async () => {
        operationCalls += 1;
        return response(
          {
            error: {
              code: 'CONFLICT_ERROR',
              status: 409,
              message: 'The operation was based on a stale revision',
              details: {
                reason: 'stale_revision',
                expectedRevision: 4,
                currentRevision: 5
              }
            }
          },
          409,
          { 'x-correlation-id': 'correlation-stale-client' }
        );
      },
      refreshState: async (actor) => {
        if (actor !== undefined) refreshedActors.push(actor);
      }
    });

    await expect(
      client.invoke(
        'create_job_requisition',
        {
          title: 'stale client role',
          department: 'Engineering',
          requirements: ['TypeScript'],
          compBand: { min: 100, max: 120, currency: 'USD' }
        },
        {
          actor: recruiter,
          metadata: {
            correlationId: 'correlation-stale-client',
            idempotencyKey: 'idempotency-stale-client',
            expectedRevision: 4
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'stale_revision' }
    });
    expect(operationCalls).toBe(1);
    expect(refreshedActors).toEqual([recruiter]);
  });

  it('hydrates actor-scoped state and carries the same actor to the SSE URL', async () => {
    const agentProjection = projectionForActor(agent.actorId);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let eventUrl = '';
    let closed = false;
    const controller = new SynchronizationController({
      actorContext: agent,
      fetcher: async (request, init) => {
        requests.push({ url: String(request), init });
        return response(agentProjection);
      },
      eventSourceFactory: (url) => {
        eventUrl = url;
        return {
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          close: () => {
            closed = true;
          }
        };
      }
    });

    try {
      await controller.start();
      expect(requests).toHaveLength(1);
      const stateHeaders = new Headers(requests[0].init?.headers);
      expect(stateHeaders.get('x-actor-type')).toBe(agent.actorType);
      expect(stateHeaders.get('x-actor-id')).toBe(agent.actorId);
      expect(useStore.getState().activityLog).toEqual([
        expect.objectContaining({ actorId: agent.actorId })
      ]);
      const eventsUrl = new URL(eventUrl, 'http://localhost');
      expect(eventsUrl.pathname).toBe('/api/events');
      expect(eventsUrl.searchParams.get('actorType')).toBe(agent.actorType);
      expect(eventsUrl.searchParams.get('actorId')).toBe(agent.actorId);
    } finally {
      controller.stop();
    }
    expect(closed).toBe(true);
  });

  it('does not let an older authoritative response regress the visible revision', async () => {
    const before = useStore.getState().snapshot();
    const currentProjection = {
      ...projectionForActor(recruiter.actorId),
      revision: 8
    };
    const staleProjection = {
      ...projectionForActor(agent.actorId),
      revision: 7
    };
    useStore.getState().hydrate(currentProjection);

    try {
      const refreshed = await refreshSharedState({
        actorContext: agent,
        fetcher: async (_request, init) => {
          const headers = new Headers(init?.headers);
          expect(headers.get('x-actor-id')).toBe(agent.actorId);
          return response(staleProjection);
        }
      });

      expect(refreshed.revision).toBe(7);
      expect(useStore.getState().revision).toBe(8);
      expect(useStore.getState().activityLog).toEqual([
        expect.objectContaining({ actorId: recruiter.actorId })
      ]);
    } finally {
      useStore.getState().hydrate(before);
    }
  });
});
