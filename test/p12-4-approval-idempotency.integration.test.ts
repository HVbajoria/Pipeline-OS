import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PipelineError, ConflictError } from '../src/shared/errors';
import type { ActorContext, JsonObject } from '../src/shared/models';
import { OperationClient } from '../src/client/operationClient';
import {
  OperationService,
  type OperationHandler
} from '../src/server/operationService';
import { createAuthorizationPolicy, createTrustedPrincipal } from '../src/server/authorization';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { approvalOperationAdapters, defaultOperationHandlers } from '../src/server/operations';
import { registerAllTools, resetWebMcpRegistry } from '../src/lib/webmcp';
import {
  PROPERTY_TEST_OPTIONS,
  TEST_TIMESTAMP,
  createTestContext
} from './factories';

const HUMAN: ActorContext = { actorType: 'human_ui', actorId: 'p12-4-human' };
const AGENT: ActorContext = { actorType: 'agent', actorId: 'p12-4-agent' };

function invocation(
  name: 'search_candidates',
  input: JsonObject,
  key: string,
  correlationId = `correlation-${key}`
) {
  return {
    name,
    input,
    actor: HUMAN,
    metadata: { idempotencyKey: key, correlationId }
  } as const;
}

function targetHandler(counters: { preview: number; commit: number }): OperationHandler<'coordinate_interview_workflow'> {
  return (input, context) => {
    const job = context.state.jobs.get('job-1');
    if (job === undefined) throw new Error('Expected seeded job');
    if (context.preview) counters.preview += 1;
    else counters.commit += 1;
    context.state.jobs.set('job-1', {
      ...job,
      title: context.preview ? 'Preview title' : 'Committed title'
    });
    return {
      applicationId: input.applicationId,
      stage: context.preview ? 'preview' : 'committed',
      proposedSlots: [],
      bookedInterview: null,
      nextAction: null,
      blockers: []
    };
  };
}

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected the operation to reject');
}

interface RunningApi {
  api: PipelineApi;
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

async function startApi(): Promise<RunningApi> {
  const context = createTestContext({ timestamp: TEST_TIMESTAMP });
  const api = createPipelineApi({
    repository: context.repository,
    handlers: defaultOperationHandlers
  });
  const server = createServer(api.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    api,
    baseUrl: `http://127.0.0.1:${address.port}`,
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

describe('P12.4 deterministic approval, idempotency, and stale-state coverage', () => {
  it('executes the duplicate/changed-input/stale-revision property at the deterministic 100-run minimum', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom<'replay' | 'changed' | 'stale'>('replay', 'changed', 'stale'),
        async (suffix, scenario) => {
          const context = createTestContext({ timestamp: TEST_TIMESTAMP });
          const key = `property-key-${suffix}`;
          const service = new OperationService(context.repository, {
            search_candidates: () => ({ results: [] }),
            create_job_requisition: (_input, handlerContext) => {
              handlerContext.state.jobs.set('property-job', {
                id: 'property-job',
                title: 'Property job',
                department: 'Engineering',
                requirements: ['TypeScript'],
                compBand: { min: 100, max: 120, currency: 'USD' },
                status: 'open',
                createdBy: HUMAN.actorId,
                createdAt: TEST_TIMESTAMP
              });
              return { jobId: 'property-job' };
            }
          });

          if (scenario === 'replay') {
            const first = await service.invoke(
              invocation('search_candidates', { query: `query-${suffix}` }, key)
            );
            const replay = await service.invoke(
              invocation(
                'search_candidates',
                { query: `query-${suffix}` },
                key,
                `replay-correlation-${suffix}`
              )
            );
            expect(replay).toEqual(first);
            expect(context.repository.read().activityLog).toHaveLength(2);
            expect(context.repository.read().activityLog.at(-1)).toMatchObject({
              phase: 'replay',
              replayed: true,
              originalActivityId: context.repository.read().activityLog[0]?.id
            });
            return;
          }

          if (scenario === 'changed') {
            await service.invoke(
              invocation('search_candidates', { query: `query-${suffix}` }, key)
            );
            const error = await captureError(
              service.invoke(
                invocation(
                  'search_candidates',
                  { query: `changed-${suffix}` },
                  key,
                  `changed-correlation-${suffix}`
                )
              )
            );
            expect(error).toMatchObject({
              code: 'CONFLICT_ERROR',
              details: { reason: 'idempotency_key_reuse' }
            });
            expect(context.repository.read().activityLog).toHaveLength(2);
            return;
          }

          const error = await captureError(
            service.invoke({
              name: 'create_job_requisition',
              input: {
                title: `Stale ${suffix}`,
                department: 'Engineering',
                requirements: ['TypeScript'],
                compBand: { min: 100, max: 120, currency: 'USD' }
              },
              actor: HUMAN,
              metadata: {
                idempotencyKey: key,
                correlationId: `stale-correlation-${suffix}`,
                expectedRevision: 99
              }
            })
          );
          expect(error).toMatchObject({
            code: 'CONFLICT_ERROR',
            details: { reason: 'stale_revision', expectedRevision: 99, currentRevision: 0 }
          });
          expect(context.repository.read().jobs.has('property-job')).toBe(false);
          expect(context.repository.read().activityLog).toHaveLength(1);
        }
      ),
      PROPERTY_TEST_OPTIONS
    );
  });

  it('replays exact errors and never reruns a changed fingerprint', async () => {
    const context = createTestContext();
    let calls = 0;
    const service = new OperationService(context.repository, {
      search_candidates: () => {
        calls += 1;
        throw new ConflictError('Stable failure', { reason: 'entity_changed' });
      }
    });

    const first = await captureError(
      service.invoke(invocation('search_candidates', { query: 'error' }, 'error-key'))
    );
    const replay = await captureError(
      service.invoke(
        invocation('search_candidates', { query: 'error' }, 'error-key', 'replay-error-correlation')
      )
    );

    expect(replay.toPayload()).toEqual(first.toPayload());
    expect(calls).toBe(1);
    expect(context.repository.read().activityLog.at(-1)).toMatchObject({
      phase: 'replay',
      replayed: true
    });
  });

  it('serializes concurrent duplicate commits into one target mutation', async () => {
    const context = createTestContext();
    const counters = { preview: 0, commit: 0 };
    const service = new OperationService({
      repository: context.repository,
      handlers: { coordinate_interview_workflow: targetHandler(counters) },
      orchestrationAdapters: approvalOperationAdapters
    });

    const plan = await service.invoke({
      name: 'plan_operation',
      input: {
        targetOperation: 'coordinate_interview_workflow',
        input: { applicationId: 'app-1', action: 'propose_slots' }
      },
      actor: HUMAN,
      metadata: { idempotencyKey: 'concurrent-plan', correlationId: 'trace-chain' }
    });
    await service.invoke({
      name: 'approve_operation_plan',
      input: { approvalId: plan.approvalId },
      actor: HUMAN,
      metadata: { idempotencyKey: 'concurrent-approval', correlationId: 'trace-chain' }
    });

    const [first, second] = await Promise.all([
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: plan.approvalId },
        actor: HUMAN,
        metadata: {
          idempotencyKey: 'concurrent-commit',
          correlationId: 'trace-chain'
        }
      }),
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: plan.approvalId },
        actor: HUMAN,
        metadata: {
          idempotencyKey: 'concurrent-commit',
          correlationId: 'trace-chain'
        }
      })
    ]);

    expect(second).toEqual(first);
    expect(counters).toEqual({ preview: 1, commit: 1 });
    expect(context.repository.read().jobs.get('job-1')?.title).toBe('Committed title');
    expect(context.repository.read().activityLog.filter((entry) => entry.toolName === 'commit_operation_plan'))
      .toHaveLength(2);
    expect(context.repository.read().activityLog.at(-1)).toMatchObject({
      phase: 'replay',
      replayed: true
    });
  });

  it('links plan, approval, and commit records while expiring a stale plan atomically', async () => {
    const context = createTestContext();
    const counters = { preview: 0, commit: 0 };
    const service = new OperationService({
      repository: context.repository,
      handlers: { coordinate_interview_workflow: targetHandler(counters) },
      orchestrationAdapters: approvalOperationAdapters
    });
    const correlationId = 'approval-correlation';
    const plan = await service.invoke({
      name: 'plan_operation',
      input: {
        targetOperation: 'coordinate_interview_workflow',
        input: { applicationId: 'app-1', action: 'propose_slots' }
      },
      actor: HUMAN,
      metadata: { idempotencyKey: 'linked-plan', correlationId }
    });
    await service.invoke({
      name: 'approve_operation_plan',
      input: { approvalId: plan.approvalId },
      actor: HUMAN,
      metadata: { idempotencyKey: 'linked-approval', correlationId }
    });

    const beforeStaleCommit = context.repository.read();
    const beforeTitle = beforeStaleCommit.jobs.get('job-1')?.title;
    context.repository.transact((draft) => {
      const job = draft.jobs.get('job-1');
      if (job === undefined) throw new Error('Expected seeded job');
      draft.jobs.set('job-1', { ...job, status: 'paused' });
    });

    const error = await captureError(
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: plan.approvalId },
        actor: HUMAN,
        metadata: {
          idempotencyKey: 'linked-commit',
          correlationId,
          approvalId: plan.approvalId
        }
      })
    );
    expect(error).toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'entity_changed', approvalId: plan.approvalId }
    });
    expect(counters.commit).toBe(0);
    expect(context.repository.read().approvalCards.get(plan.approvalId)?.status).toBe('expired');
    expect(context.repository.read().jobs.get('job-1')?.title).toBe(beforeTitle);

    const related = context.repository.read().activityLog.filter(
      (entry) => entry.approvalId === plan.approvalId
    );
    expect(related.length).toBeGreaterThanOrEqual(3);
    expect(new Set(related.map((entry) => entry.correlationId))).toEqual(new Set([correlationId]));
    expect(related.every((entry) => entry.traceId !== undefined && entry.trace !== undefined)).toBe(true);
  });

  it('keeps approval IDs outside input agreement, preserves legacy activity shape, and redacts sensitive output', async () => {
    const context = createTestContext();
    let calls = 0;
    const profileHandler: OperationHandler<'get_candidate_profile'> = () => {
      calls += 1;
      return {
        id: 'cand-1',
        name: 'Ananya Sharma',
        email: 'ananya.sharma@example.test',
        resumeText: 'private resume text',
        skills: ['TypeScript'],
        experienceYears: 8,
        resumeTextHistory: [],
        applicationHistory: []
      };
    };
    const service = new OperationService(context.repository, {
      get_candidate_profile: profileHandler,
      search_candidates: () => ({ results: [] })
    });

    const mismatch = await captureError(
      service.invoke({
        name: 'approve_operation_plan',
        input: { approvalId: 'approval-a' },
        actor: HUMAN,
        metadata: {
          approvalId: 'approval-b',
          idempotencyKey: 'approval-mismatch'
        }
      })
    );
    expect(mismatch).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'metadata_invalid', field: 'metadata.approvalId' }
    });

    const profile = await service.invoke({
      name: 'get_candidate_profile',
      input: { candidateId: 'cand-1' },
      actor: HUMAN,
      metadata: { idempotencyKey: 'redaction-profile' }
    });
    expect(profile.resumeText).toBe('private resume text');
    const activity = context.repository.read().activityLog.at(-1)!;
    expect(activity.output).not.toHaveProperty('resumeText');
    expect(JSON.stringify(activity)).not.toContain('alice@example.test');
    expect(JSON.stringify(activity)).not.toContain('private resume text');
    expect(calls).toBe(1);

    const legacyService = new OperationService(context.repository, {
      search_candidates: () => ({ results: [] })
    });
    await legacyService.invoke('search_candidates', {}, HUMAN);
    const legacyActivity = context.repository.read().activityLog.at(-1)!;
    expect(Object.keys(legacyActivity).sort()).toEqual([
      'actorId',
      'actorType',
      'id',
      'input',
      'output',
      'timestamp',
      'toolName'
    ]);
  });

  it('enforces target resource scope and prevents a forbidden handler from observing state', async () => {
    const context = createTestContext();
    let calls = 0;
    const principal = createTrustedPrincipal({
      actor: { actorType: 'human_ui', actorId: 'p12-4-candidate' },
      role: 'candidate',
      resourceScopes: [
        {
          resourceType: 'candidate',
          mode: 'self',
          resourceIds: ['cand-1'],
          subjectId: 'cand-1'
        }
      ]
    });
    const service = new OperationService({
      repository: context.repository,
      principal,
      authorizationPolicy: createAuthorizationPolicy({ environment: 'test' }),
      handlers: {
        get_candidate_profile: () => {
          calls += 1;
          return {
            id: 'cand-2',
            name: 'Hidden',
            email: 'hidden@example.test',
            resumeText: 'hidden',
            skills: [],
            experienceYears: 1,
            resumeTextHistory: [],
            applicationHistory: []
          };
        }
      }
    });

    const error = await captureError(
      service.invoke({
        name: 'get_candidate_profile',
        input: { candidateId: 'cand-2' },
        actor: principal.actor,
        metadata: { idempotencyKey: 'scope-denied' }
      })
    );
    expect(error).toMatchObject({
      code: 'FORBIDDEN_ERROR',
      details: { reason: 'resource_scope' }
    });
    expect(calls).toBe(0);
  });

  it('returns the same structured error envelope through OperationClient and WebMCP', async () => {
    const running = await startApi();
    resetWebMcpRegistry();
    try {
      const client = new OperationClient({
        baseUrl: running.baseUrl,
        actorContext: HUMAN,
        refreshState: async () => undefined
      });
      const invalidInput = { query: 42 } as never;
      const uiError = await captureError(client.invoke('search_candidates', invalidInput));

      const tools = registerAllTools({ client, force: true });
      const webMcpTool = tools.find((tool) => tool.name === 'search_candidates');
      expect(webMcpTool).toBeDefined();
      const webMcpError = await captureError(webMcpTool!.execute(invalidInput));

      expect(webMcpError.toPayload()).toEqual(uiError.toPayload());
      expect(running.api.repository.read().activityLog).toHaveLength(2);
      expect(running.api.repository.read().activityLog.every((entry) => entry.output).valueOf()).toBe(true);
    } finally {
      resetWebMcpRegistry();
      await running.close();
    }
  });
});
