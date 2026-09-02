import {
  createServer,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ActorContext,
  SharedStateProjectionWithCatalogs,
  SharedStateWithCatalogs
} from '../src/shared/models';
import type {
  ImportPublicProspectInput,
  PlanOperationInput
} from '../src/shared/operations';
import { PipelineError } from '../src/shared/errors';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import GitHubProspectsPanel from '../src/components/GitHubProspectsPanel';
import { useStore } from '../src/lib/store';
import {
  registerAllTools,
  resetWebMcpRegistry,
  WebMcpRuntimeAdapter,
  type WebMcpRegisteredTool
} from '../src/lib/webmcp';
import { serializeSharedState } from '../src/server/api';
import {
  applyPublicProspectRetention,
  PUBLIC_PROSPECT_RETENTION_DAYS
} from '../src/server/operations/importPublicProspect';
import { defaultOperationAdapters, defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { createSeed } from '../src/server/seed';
import { SharedStateRepository } from '../src/server/repository';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { createTestContext, TEST_TIMESTAMP } from './factories';

const HUMAN: ActorContext = { actorType: 'human_ui', actorId: 'sarah-recruiter' };
const AGENT: ActorContext = { actorType: 'agent', actorId: 'agent-p14' };
const PRIVATE_EMAIL = 'candidate.private@example.test';
const PRIVATE_RESUME = 'PRIVATE_RESUME marker token-secret';
const CONSENT_POLICY = 'p14.test.v1';

function sourceInput(): ImportPublicProspectInput {
  return {
    source: 'github',
    sourceRecordId: 'public-user-1',
    profileUrl: 'https://github.com/public-user-1',
    canonicalSourceUrl: 'https://api.github.com/users/public-user-1',
    sourceQuery: 'backend engineer',
    fetchedAt: TEST_TIMESTAMP,
    attribution: {
      source: 'github',
      apiUrl: 'https://api.github.com/search/users',
      searchApiDocsUrl: 'https://docs.github.com/en/rest/search/search',
      rateLimitsDocsUrl: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits',
      userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
    },
    consent: {
      method: 'approved_consent_channel',
      scope: 'candidate-profile-import',
      capturedAt: TEST_TIMESTAMP,
      capturedBy: HUMAN,
      evidenceRef: 'consent-record-1',
      policyVersion: CONSENT_POLICY
    }
  };
}

function candidateInput(): ImportPublicProspectInput {
  return {
    ...sourceInput(),
    consent: {
      ...sourceInput().consent,
      method: 'candidate_submitted'
    },
    candidateProfile: {
      name: 'Candidate Submitted',
      email: PRIVATE_EMAIL,
      resumeText: PRIVATE_RESUME,
      skills: ['TypeScript', 'Node.js'],
      experienceYears: 6
    }
  };
}

function serviceFor(context: ReturnType<typeof createTestContext>): OperationService {
  return new OperationService({
    repository: context.repository,
    handlers: defaultOperationHandlers,
    orchestrationAdapters: defaultOperationAdapters
  });
}

function projectionFor(repository: SharedStateRepository): SharedStateProjectionWithCatalogs {
  return serializeSharedState(repository.read());
}

function domainCollections(state: SharedStateWithCatalogs) {
  return {
    jobs: [...state.jobs.entries()],
    candidates: [...state.candidates.entries()],
    applications: [...state.applications.entries()],
    panels: [...state.panels.entries()],
    interviews: [...state.interviews.entries()],
    scorecards: [...state.scorecards.entries()],
    offers: [...state.offers.entries()],
    onboardingTasks: [...state.onboardingTasks.entries()],
    backgroundChecks: [...state.backgroundChecks.entries()],
    benefitsEnrollments: [...state.benefitsEnrollments.entries()],
    sourcedProspects: [...state.sourcedProspects.entries()]
  };
}

class CapturingAdapter extends WebMcpRuntimeAdapter {
  readonly tools: WebMcpRegisteredTool[] = [];

  override register(tool: WebMcpRegisteredTool): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

interface RunningApi {
  api: PipelineApi;
  baseUrl: string;
  server: Server;
}

async function startApi(): Promise<RunningApi> {
  const context = createTestContext({ timestamp: TEST_TIMESTAMP });
  const api = createPipelineApi({ repository: context.repository });
  const server = createServer(api.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { api, baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopApi(running: RunningApi): Promise<void> {
  running.api.events.close();
  running.server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readProjection(
  baseUrl: string,
  actor: ActorContext
): Promise<SharedStateProjectionWithCatalogs> {
  const response = await fetch(`${baseUrl}/api/state`, {
    headers: {
      accept: 'application/json',
      'x-actor-type': actor.actorType,
      'x-actor-id': actor.actorId
    }
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SharedStateProjectionWithCatalogs;
}

afterEach(() => {
  useStore.getState().hydrate(projectionFor(new SharedStateRepository(createSeed())));
  useStore.getState().setRole('recruiter');
  resetWebMcpRegistry();
});

describe('P14 public-prospect consent, retention, and privacy boundaries', () => {
  it('requires consent, lets an agent plan only, and commits one approved import idempotently', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const before = context.repository.read();

    await expect(
      service.invoke(
        'import_public_prospect',
        { ...sourceInput(), consent: undefined } as never,
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(domainCollections(context.repository.read())).toEqual(
      domainCollections(before)
    );

    const planned = await service.invoke({
      name: 'plan_operation',
      input: {
        targetOperation: 'import_public_prospect',
        input: candidateInput() as unknown as PlanOperationInput['input']
      },
      actor: AGENT,
      metadata: { idempotencyKey: 'p14-plan-import' }
    });

    expect(planned.status).toBe('pending');
    expect(context.repository.read().sourcedProspects).toHaveLength(0);
    expect(context.repository.read().candidates).toHaveLength(3);

    for (const [name, input, key] of [
      ['import_public_prospect', candidateInput(), 'p14-agent-import'],
      ['approve_operation_plan', { approvalId: planned.approvalId }, 'p14-agent-approve'],
      ['commit_operation_plan', { approvalId: planned.approvalId }, 'p14-agent-commit'],
      ['revoke_public_prospect_consent', { sourcedProspectId: 'missing' }, 'p14-agent-revoke']
    ] as const) {
      await expect(
        service.invoke({
          name,
          input: input as never,
          actor: AGENT,
          metadata: { idempotencyKey: key }
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN_ERROR', status: 403 });
    }

    const approved = await service.invoke({
      name: 'approve_operation_plan',
      input: { approvalId: planned.approvalId },
      actor: HUMAN,
      metadata: {
        idempotencyKey: 'p14-human-approve',
        approvalId: planned.approvalId
      }
    });
    expect(approved.status).toBe('approved');

    const committed = await service.invoke({
      name: 'commit_operation_plan',
      input: { approvalId: planned.approvalId },
      actor: HUMAN,
      metadata: {
        idempotencyKey: 'p14-human-commit',
        approvalId: planned.approvalId
      }
    });
    const replay = await service.invoke({
      name: 'commit_operation_plan',
      input: { approvalId: planned.approvalId },
      actor: HUMAN,
      metadata: {
        idempotencyKey: 'p14-human-commit',
        approvalId: planned.approvalId
      }
    });

    expect(committed).toEqual(expect.objectContaining({ status: 'committed' }));
    expect(replay).toEqual(committed);
    expect(context.repository.read().sourcedProspects).toHaveLength(1);
    expect(context.repository.read().candidates).toHaveLength(4);
    expect(context.repository.read().approvalCards.get(planned.approvalId)?.status).toBe(
      'committed'
    );
  });

  it('makes revocation terminal and applies deletion, unlink, and expiry retention rules', async () => {
    const createdContext = createTestContext({ timestamp: TEST_TIMESTAMP });
    const createdService = serviceFor(createdContext);
    const created = await createdService.invoke(
      'import_public_prospect',
      candidateInput(),
      HUMAN
    );
    const candidateId = created.candidateId!;

    const revoked = await createdService.invoke({
      name: 'revoke_public_prospect_consent',
      input: { sourcedProspectId: created.sourcedProspect.id },
      actor: HUMAN,
      metadata: { idempotencyKey: 'p14-revoke-created' }
    });
    const replay = await createdService.invoke({
      name: 'revoke_public_prospect_consent',
      input: { sourcedProspectId: created.sourcedProspect.id },
      actor: HUMAN,
      metadata: { idempotencyKey: 'p14-revoke-created' }
    });
    const createdState = createdContext.repository.read();

    expect(replay).toEqual(revoked);
    expect(createdState.sourcedProspects.get(created.sourcedProspect.id)).toMatchObject({
      consentStatus: 'withdrawn',
      withdrawnAt: revoked.withdrawnAt
    });
    expect(createdState.sourcedProspects.get(created.sourcedProspect.id)?.candidateId).toBeUndefined();
    expect(createdState.sourcedProspects.get(created.sourcedProspect.id)?.candidateLinkOrigin).toBeUndefined();
    expect(createdState.candidates.has(candidateId)).toBe(false);

    const seed = createSeed();
    seed.candidates.set('cand-1', {
      ...seed.candidates.get('cand-1')!,
      email: PRIVATE_EMAIL
    });
    const existingContext = createTestContext({ seed, timestamp: TEST_TIMESTAMP });
    const existingService = serviceFor(existingContext);
    const linked = await existingService.invoke(
      'import_public_prospect',
      candidateInput(),
      HUMAN
    );
    await existingService.invoke(
      'revoke_public_prospect_consent',
      { sourcedProspectId: linked.sourcedProspect.id },
      HUMAN
    );
    const existingState = existingContext.repository.read();
    expect(existingState.candidates.has('cand-1')).toBe(true);
    expect(existingState.sourcedProspects.get(linked.sourcedProspect.id)?.candidateId).toBeUndefined();
    expect(existingState.sourcedProspects.get(linked.sourcedProspect.id)?.candidateLinkOrigin).toBeUndefined();

    const expiryContext = createTestContext({ timestamp: TEST_TIMESTAMP });
    const expiryService = serviceFor(expiryContext);
    const expiring = await expiryService.invoke(
      'import_public_prospect',
      candidateInput(),
      HUMAN
    );
    const cleanup = expiryContext.repository.transact((draft) =>
      applyPublicProspectRetention(
        draft,
        new Date(
          Date.parse(TEST_TIMESTAMP) + (PUBLIC_PROSPECT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000
        ).toISOString()
      )
    );
    const expiryState = expiryContext.repository.read();

    expect(cleanup.expiredProspectIds).toEqual([expiring.sourcedProspect.id]);
    expect(cleanup.deletedCandidateIds).toEqual([expiring.candidateId]);
    expect(expiryState.sourcedProspects.get(expiring.sourcedProspect.id)).toMatchObject({
      consentStatus: 'expired',
      expiredAt: expect.any(String)
    });
    expect(expiryState.candidates.has(expiring.candidateId!)).toBe(false);
  });
});

describe('P14 canonical HTTP, UI, trace, and WebMCP privacy parity', () => {
  it('propagates metadata through real HTTP and keeps private candidate fields out of projections', async () => {
    const running = await startApi();
    const fetcher = globalThis.fetch.bind(globalThis) as unknown as FetchLike;
    const client = new OperationClient({
      baseUrl: running.baseUrl,
      fetcher
    });
    const input = {
      targetOperation: 'import_public_prospect' as const,
      input: candidateInput() as unknown as PlanOperationInput['input']
    } satisfies PlanOperationInput;

    try {
      const planned = await client.invoke('plan_operation', input, {
        actor: AGENT,
        metadata: {
          correlationId: 'p14-http-correlation',
          parentSpanId: 'p14-parent-span'
        }
      });
      const projection = await readProjection(running.baseUrl, AGENT);
      const activity = projection.activityLog.at(-1);

      expect(client.getLastResponseMetadata().correlationId).toBe('p14-http-correlation');
      expect(activity).toMatchObject({
        toolName: 'plan_operation',
        actorType: 'agent',
        actorId: AGENT.actorId,
        correlationId: 'p14-http-correlation',
        parentSpanId: 'p14-parent-span',
        trace: { spans: expect.arrayContaining([
          expect.objectContaining({ name: 'plan_operation', status: 'completed' }),
          expect.objectContaining({ name: 'plan:import_public_prospect', status: 'completed' })
        ]) }
      });
      expect(planned.approvalId).toBeTruthy();
      expect(JSON.stringify(planned)).not.toContain(PRIVATE_EMAIL);
      expect(JSON.stringify(planned)).not.toContain(PRIVATE_RESUME);
      expect(JSON.stringify(projection)).not.toContain(PRIVATE_EMAIL);
      expect(JSON.stringify(projection)).not.toContain(PRIVATE_RESUME);
      expect(JSON.stringify(projection)).not.toContain('token-secret');
      expect(activity?.input).not.toHaveProperty('metadata');
      expect(activity?.input).not.toHaveProperty('candidateProfile');

      useStore.getState().hydrate(projection);
      const markup = renderToStaticMarkup(
        createElement(GitHubProspectsPanel, { actor: HUMAN })
      );
      expect(markup).toContain('Consent and provenance records');
      expect(markup).toContain('No consented public prospects have been imported');
      expect(markup).not.toContain(PRIVATE_EMAIL);
      expect(markup).not.toContain(PRIVATE_RESUME);
    } finally {
      await stopApi(running);
    }
  });

  it('uses the same canonical HTTP operation for WebMCP mutation metadata and safe output', async () => {
    const running = await startApi();
    const fetcher = globalThis.fetch.bind(globalThis) as unknown as FetchLike;
    const client = new OperationClient({ baseUrl: running.baseUrl, fetcher });
    const adapter = new CapturingAdapter();
    const input = {
      targetOperation: 'import_public_prospect' as const,
      input: candidateInput() as unknown as PlanOperationInput['input']
    } satisfies PlanOperationInput;

    try {
      registerAllTools({
        client,
        agentContext: AGENT,
        adapter,
        force: true
      });
      const tool = adapter.tools.find((candidate) => candidate.name === 'plan_operation');
      expect(tool).toBeDefined();
      const output = await tool!.execute(input);
      const projection = await readProjection(running.baseUrl, AGENT);
      const activity = projection.activityLog.at(-1);

      expect(output).toEqual(expect.objectContaining({
        targetOperation: 'import_public_prospect',
        status: 'pending',
        proposedOutput: expect.objectContaining({
          sourcedProspect: expect.objectContaining({
            source: 'github',
            dataOrigin: 'public_github',
            fieldOrigins: expect.any(Object),
            attribution: expect.objectContaining({ source: 'github' })
          })
        })
      }));
      expect(JSON.stringify(output)).not.toContain(PRIVATE_EMAIL);
      expect(JSON.stringify(output)).not.toContain(PRIVATE_RESUME);
      expect(JSON.stringify(projection)).not.toContain(PRIVATE_EMAIL);
      expect(JSON.stringify(projection)).not.toContain(PRIVATE_RESUME);
      expect(activity).toMatchObject({
        toolName: 'plan_operation',
        actorId: AGENT.actorId,
        phase: 'plan',
        trace: { spans: expect.any(Array) }
      });
    } finally {
      await stopApi(running);
    }
  });
});


describe('P14 safe provenance projection', () => {
  it('preserves provenance, field origins, attribution, and retention in server and UI projections', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const imported = await serviceFor(context).invoke(
      'import_public_prospect',
      sourceInput(),
      HUMAN
    );
    const projection = projectionFor(context.repository);
    const record = projection.sourcedProspects?.find(
      (candidate) => candidate.id === imported.sourcedProspect.id
    );

    expect(record).toMatchObject({
      source: 'github',
      dataOrigin: 'public_github',
      consentStatus: 'explicit',
      fieldOrigins: expect.objectContaining({
        sourceRecordId: 'github_public',
        consent: 'recruiter_entered'
      }),
      attribution: expect.objectContaining({ source: 'github' }),
      retentionExpiresAt: expect.any(String)
    });
    expect(JSON.stringify(record)).not.toContain(PRIVATE_EMAIL);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_RESUME);

    const uiProjection = {
      ...projection,
      sourcedProspects: projection.sourcedProspects?.map((candidate) => ({
        ...candidate,
        retentionExpiresAt: '2099-01-01T00:00:00.000Z'
      }))
    };
    useStore.getState().hydrate(uiProjection);
    const initialState = useStore.getInitialState();
    const initialValues = { ...initialState };
    Object.assign(initialState, useStore.getState());
    let markup: string;
    try {
      markup = renderToStaticMarkup(
        createElement(GitHubProspectsPanel, { actor: HUMAN })
      );
    } finally {
      Object.assign(initialState, initialValues);
    }
    expect(markup).toContain('Consent and provenance records');
    expect(markup).toContain('Field origins:');
    expect(markup).toContain('github_public');
    expect(markup).toContain('retention expires');
    expect(markup).toContain('Withdraw consent');
    expect(markup).not.toContain(PRIVATE_EMAIL);
    expect(markup).not.toContain(PRIVATE_RESUME);
  });
});
