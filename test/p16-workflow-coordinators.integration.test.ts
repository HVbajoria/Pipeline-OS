import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { refreshSharedState } from '../src/client/synchronization';
import {
  registerAllTools,
  resetWebMcpRegistry,
  WebMcpRuntimeAdapter,
  type WebMcpRegisteredTool
} from '../src/lib/webmcp';
import { PipelineError } from '../src/shared/errors';
import type {
  ActorContext,
  ApplicationRecord,
  OfferRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import type {
  CoordinateInterviewWorkflowOutput,
  CoordinateOnboardingWorkflowOutput,
  OperationInvocation
} from '../src/shared/operations';
import {
  createAuthorizationPolicy,
  DemoActorResolver
} from '../src/server/authorization';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { createSeed } from '../src/server/seed';
import { TEST_TIMESTAMP, createTestContext } from './factories';

const HUMAN: ActorContext = {
  actorType: 'human_ui',
  actorId: 'p16-http-recruiter'
};
const AGENT: ActorContext = {
  actorType: 'agent',
  actorId: 'agent-demo'
};

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

class CapturingAdapter extends WebMcpRuntimeAdapter {
  readonly tools: WebMcpRegisteredTool[] = [];

  override register(tool: WebMcpRegisteredTool): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

function applicationFixture(
  status: ApplicationRecord['status'],
  id = 'p16-application'
): ApplicationRecord {
  return {
    id,
    candidateId: 'cand-1',
    jobId: 'job-1',
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

function offerFixture(
  applicationId: string,
  status: OfferRecord['status'] = 'accepted',
  id = 'p16-offer'
): OfferRecord {
  return {
    id,
    applicationId,
    compAmount: 175000,
    currency: 'USD',
    status,
    counterAmount: null,
    sentAt: TEST_TIMESTAMP,
    respondedAt: TEST_TIMESTAMP
  };
}

function interviewContext(idPrefix = 'p16-http-interview') {
  const seed = createSeed();
  const application = applicationFixture('screened');
  seed.applications = new Map([[application.id, application]]);
  return { context: createTestContext({ seed, idPrefix }), application };
}

function onboardingContext(idPrefix = 'p16-http-onboarding') {
  const seed = createSeed();
  const application = applicationFixture('offer_accepted');
  const offer = offerFixture(application.id);
  seed.applications = new Map([[application.id, application]]);
  seed.offers = new Map([[offer.id, offer]]);
  return { context: createTestContext({ seed, idPrefix }), application, offer };
}

function domainSnapshot(state: SharedStateWithCatalogs) {
  return {
    applications: state.applications,
    interviews: state.interviews,
    offers: state.offers,
    onboardingTasks: state.onboardingTasks,
    backgroundChecks: state.backgroundChecks,
    benefitsEnrollments: state.benefitsEnrollments
  };
}

function actorHeaders(actor: ActorContext): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-actor-type': actor.actorType,
    'x-actor-id': actor.actorId
  };
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  actor: ActorContext,
  metadata?: Record<string, unknown>,
  canonicalEnvelope = true
): Promise<HttpResult> {
  const requestBody = canonicalEnvelope
    ? {
        input: body,
        ...(metadata === undefined ? {} : { metadata })
      }
    : body;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: actorHeaders(actor),
    body: JSON.stringify(requestBody)
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

async function startApi(
  context: ReturnType<typeof createTestContext>
): Promise<RunningApi> {
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

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected the operation to reject');
}

function operationClientFor(
  running: RunningApi,
  actor: ActorContext,
  refreshedActors: ActorContext[] = []
): OperationClient {
  const fetcher = fetch.bind(globalThis) as FetchLike;
  return new OperationClient({
    baseUrl: running.baseUrl,
    fetcher,
    actorContext: actor,
    refreshState: async (refreshedActor) => {
      if (refreshedActor !== undefined) refreshedActors.push(refreshedActor);
      return refreshSharedState({
        baseUrl: running.baseUrl,
        fetcher,
        actor: refreshedActor
      });
    }
  });
}

describe('P16 canonical coordinator HTTP, WebMCP, and policy parity', () => {
  it('propagates metadata headers, replays exactly, traces child spans, and rejects stale/invalid actions atomically', async () => {
    const { context, application } = interviewContext();
    const running = await startApi(context);
    try {
      const input = {
        applicationId: application.id,
        action: 'propose_slots'
      } as const;
      const metadata = {
        idempotencyKey: 'p16-http-proposal',
        correlationId: 'p16-http-correlation',
        parentSpanId: 'p16-http-parent'
      };
      const first = await jsonRequest(
        running.baseUrl,
        '/api/operations/coordinate_interview_workflow',
        input,
        HUMAN,
        metadata
      );
      expect(first.status).toBe(200);
      expect(first.headers.get('x-correlation-id')).toBe(metadata.correlationId);
      expect(first.headers.get('x-trace-id')).toBeTruthy();
      expect(first.headers.get('x-span-id')).toBeTruthy();
      expect(first.headers.get('x-parent-span-id')).toBe(metadata.parentSpanId);
      expect(first.headers.get('x-idempotency-replayed')).toBeNull();
      const firstOutput = first.body as CoordinateInterviewWorkflowOutput;
      expect(firstOutput.proposedSlots).toHaveLength(3);

      const firstState = context.repository.read();
      const firstActivity = firstState.activityLog.at(-1)!;
      expect(firstActivity.trace?.spans.map((span) => span.name)).toEqual(
        expect.arrayContaining([
          'coordinate_interview_workflow',
          'handler:coordinate_interview_workflow',
          'interview.propose_slots'
        ])
      );
      const root = firstActivity.trace?.spans[0];
      const handlerSpan = firstActivity.trace?.spans.find(
        (span) => span.name === 'handler:coordinate_interview_workflow'
      );
      const coordinatorSpan = firstActivity.trace?.spans.find(
        (span) => span.name === 'interview.propose_slots'
      );
      expect(handlerSpan?.parentSpanId).toBe(root?.spanId);
      // Coordinator internals are deliberately root children. This keeps the
      // trace context API stable for handlers while the service handler span
      // remains a separate root child.
      expect(coordinatorSpan?.parentSpanId).toBe(root?.spanId);

      const replay = await jsonRequest(
        running.baseUrl,
        '/api/operations/coordinate_interview_workflow',
        input,
        HUMAN,
        metadata
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.get('x-correlation-id')).toBe(metadata.correlationId);
      expect(replay.headers.get('x-idempotency-replayed')).toBe('true');
      expect(replay.headers.get('x-idempotency-original-activity-id')).toBe(
        firstActivity.id
      );
      expect(context.repository.read().interviews).toHaveLength(3);

      const refreshedActors: ActorContext[] = [];
      const client = operationClientFor(running, HUMAN, refreshedActors);
      const bookInput = {
        applicationId: application.id,
        action: 'book_slot',
        slot: firstOutput.proposedSlots[1]!.slot
      } as const;
      const booked = await client.invoke(
        'coordinate_interview_workflow',
        bookInput,
        {
          actor: HUMAN,
          metadata: {
            idempotencyKey: 'p16-http-book',
            correlationId: 'p16-http-book-correlation'
          }
        }
      );
      expect(booked.bookedInterview?.slot).toBe(bookInput.slot);
      expect(refreshedActors).toEqual([HUMAN]);
      expect(context.repository.read().applications.get(application.id)?.status).toBe(
        'interviewing'
      );

      const beforeStale = domainSnapshot(context.repository.read());
      const stale = await jsonRequest(
        running.baseUrl,
        '/api/operations/coordinate_interview_workflow',
        bookInput,
        HUMAN,
        {
          idempotencyKey: 'p16-http-stale',
          correlationId: 'p16-http-stale-correlation',
          expectedRevision: 0
        }
      );
      expect(stale.status).toBe(409);
      expect((stale.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'stale_revision'
      );
      expect(domainSnapshot(context.repository.read())).toEqual(beforeStale);

      const beforeInvalid = domainSnapshot(context.repository.read());
      const invalid = await jsonRequest(
        running.baseUrl,
        '/api/operations/coordinate_interview_workflow',
        { applicationId: application.id, action: 'invalid-action' },
        HUMAN,
        { idempotencyKey: 'p16-http-invalid' }
      );
      expect(invalid.status).toBe(400);
      expect(domainSnapshot(context.repository.read())).toEqual(beforeInvalid);
      expect(context.repository.read().activityLog.at(-1)?.trace?.spans.every((span) => span.status !== 'started')).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('keeps low-level compatibility aliases and both real coordinator WebMCP tools equivalent to OperationClient', async () => {
    const webInterview = interviewContext('p16-web-interview');
    const directInterview = interviewContext('p16-web-interview');
    const webOnboarding = onboardingContext('p16-web-onboarding');
    const directOnboarding = onboardingContext('p16-web-onboarding');
    const webInterviewApi = await startApi(webInterview.context);
    const directInterviewApi = await startApi(directInterview.context);
    const webOnboardingApi = await startApi(webOnboarding.context);
    const directOnboardingApi = await startApi(directOnboarding.context);
    resetWebMcpRegistry();
    try {
      const webInterviewClient = operationClientFor(webInterviewApi, HUMAN);
      const directInterviewClient = operationClientFor(directInterviewApi, HUMAN);
      const interviewAdapter = new CapturingAdapter();
      registerAllTools({
        client: webInterviewClient,
        agentContext: HUMAN,
        adapter: interviewAdapter,
        force: true
      });
      const interviewTool = interviewAdapter.tools.find(
        (tool) => tool.name === 'coordinate_interview_workflow'
      );
      expect(interviewTool).toBeDefined();
      expect(interviewTool?.requiredCapability).toBe('interview.coordinate');
      const webProposal = (await interviewTool!.execute({
        applicationId: webInterview.application.id,
        action: 'propose_slots'
      })) as CoordinateInterviewWorkflowOutput;
      const directProposal = await directInterviewClient.invoke(
        'coordinate_interview_workflow',
        {
          applicationId: directInterview.application.id,
          action: 'propose_slots'
        },
        {
          actor: HUMAN,
          metadata: { idempotencyKey: 'p16-direct-proposal' }
        }
      );
      expect(webProposal).toEqual(directProposal);

      const webBooking = (await interviewTool!.execute({
        applicationId: webInterview.application.id,
        action: 'book_slot',
        slot: webProposal.proposedSlots[0]!.slot
      })) as CoordinateInterviewWorkflowOutput;
      const directBooking = await directInterviewClient.invoke(
        'coordinate_interview_workflow',
        {
          applicationId: directInterview.application.id,
          action: 'book_slot',
          slot: directProposal.proposedSlots[0]!.slot
        },
        {
          actor: HUMAN,
          metadata: { idempotencyKey: 'p16-direct-booking' }
        }
      );
      expect(webBooking).toEqual(directBooking);

      const webOnboardingClient = operationClientFor(webOnboardingApi, HUMAN);
      const directOnboardingClient = operationClientFor(directOnboardingApi, HUMAN);
      const onboardingAdapter = new CapturingAdapter();
      registerAllTools({
        client: webOnboardingClient,
        agentContext: HUMAN,
        adapter: onboardingAdapter,
        force: true
      });
      const onboardingTool = onboardingAdapter.tools.find(
        (tool) => tool.name === 'coordinate_onboarding_workflow'
      );
      expect(onboardingTool).toBeDefined();
      expect(onboardingTool?.requiredCapability).toBe('onboarding.coordinate');
      const webChecklist = (await onboardingTool!.execute({
        offerId: webOnboarding.offer.id,
        action: 'initialize_checklist'
      })) as CoordinateOnboardingWorkflowOutput;
      const directChecklist = await directOnboardingClient.invoke(
        'coordinate_onboarding_workflow',
        {
          offerId: directOnboarding.offer.id,
          action: 'initialize_checklist'
        },
        {
          actor: HUMAN,
          metadata: { idempotencyKey: 'p16-direct-checklist' }
        }
      );
      expect(webChecklist).toEqual(directChecklist);
      expect(webChecklist.changedTasks.every((task) => task.status === 'pending')).toBe(true);

      const lowLevelInterview = interviewContext('p16-low-level-interview');
      const lowLevelInterviewApi = await startApi(lowLevelInterview.context);
      const lowLevelProposal = await jsonRequest(
        lowLevelInterviewApi.baseUrl,
        '/api/interviews/propose',
        { applicationId: lowLevelInterview.application.id },
        HUMAN,
        undefined,
        false
      );
      expect(lowLevelProposal.status).toBe(200);
      expect(lowLevelProposal.body).toMatchObject({ proposedSlots: expect.any(Array) });

      const lowLevelOnboarding = onboardingContext('p16-low-level-onboarding');
      const lowLevelOnboardingApi = await startApi(lowLevelOnboarding.context);
      const lowLevelChecklist = await jsonRequest(
        lowLevelOnboardingApi.baseUrl,
        `/api/offers/${lowLevelOnboarding.offer.id}/onboarding`,
        {},
        HUMAN,
        undefined,
        false
      );
      expect(lowLevelChecklist.status).toBe(200);
      expect(lowLevelChecklist.body).toMatchObject({ tasks: expect.any(Array) });
      await lowLevelInterviewApi.close();
      await lowLevelOnboardingApi.close();
    } finally {
      resetWebMcpRegistry();
      await Promise.all([
        webInterviewApi.close(),
        directInterviewApi.close(),
        webOnboardingApi.close(),
        directOnboardingApi.close()
      ]);
    }
  });

  it('enforces agent plan -> trusted human approval -> atomic coordinator commit through real policy handlers', async () => {
    const { context, application } = interviewContext('p16-policy');
    const resolver = new DemoActorResolver('test');
    const policy = createAuthorizationPolicy({ environment: 'test' });
    const agentPrincipal = resolver.resolve({
      environment: 'test',
      headers: { 'x-actor-type': AGENT.actorType, 'x-actor-id': AGENT.actorId }
    });
    const recruiterPrincipal = resolver.resolve({
      environment: 'test',
      headers: {
        'x-actor-type': 'human_ui',
        'x-actor-id': 'sarah-recruiter'
      }
    });
    const service = new OperationService({
      repository: context.repository,
      handlers: defaultOperationHandlers,
      authorizationPolicy: policy,
      environment: 'test'
    });
    const targetInput = {
      applicationId: application.id,
      action: 'propose_slots'
    } as const;
    const plan = await service.invoke(
      {
        name: 'plan_operation',
        input: {
          targetOperation: 'coordinate_interview_workflow',
          input: targetInput
        },
        actor: agentPrincipal.actor,
        metadata: {
          idempotencyKey: 'p16-policy-plan',
          correlationId: 'p16-policy-correlation'
        }
      },
      { principal: agentPrincipal, environment: 'test' }
    );
    expect(plan.targetOperation).toBe('coordinate_interview_workflow');
    expect(plan.requiredApproval).toBe('human');
    expect(context.repository.read().interviews).toHaveLength(0);

    const agentApprovalError = await captureError(
      service.invoke(
        {
          name: 'approve_operation_plan',
          input: { approvalId: plan.approvalId },
          actor: agentPrincipal.actor,
          metadata: { idempotencyKey: 'p16-policy-agent-approval' }
        },
        { principal: agentPrincipal, environment: 'test' }
      )
    );
    expect(agentApprovalError.status).toBe(403);
    expect(context.repository.read().approvalCards.get(plan.approvalId)?.status).toBe('pending');

    const approved = await service.invoke(
      {
        name: 'approve_operation_plan',
        input: { approvalId: plan.approvalId, note: 'Reviewed by recruiting owner' },
        actor: recruiterPrincipal.actor,
        metadata: { idempotencyKey: 'p16-policy-human-approval' }
      },
      { principal: recruiterPrincipal, environment: 'test' }
    );
    expect(approved.status).toBe('approved');
    expect(context.repository.read().interviews).toHaveLength(0);

    const committed = await service.invoke(
      {
        name: 'commit_operation_plan',
        input: { approvalId: plan.approvalId },
        actor: recruiterPrincipal.actor,
        metadata: { idempotencyKey: 'p16-policy-human-commit' }
      },
      { principal: recruiterPrincipal, environment: 'test' }
    );
    expect(committed.status).toBe('committed');
    expect(context.repository.read().interviews).toHaveLength(3);
    expect(context.repository.read().approvalCards.get(plan.approvalId)?.status).toBe('committed');
  });
});
