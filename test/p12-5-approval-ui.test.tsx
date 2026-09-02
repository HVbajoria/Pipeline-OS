import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import ApprovalCardsPanel, {
  invokeApprovalCardAction
} from '../src/components/ApprovalCardsPanel';
import {
  actorContextForAgent,
  actorContextForRole
} from '../src/client/actorContext';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { useStore } from '../src/lib/store';
import {
  projectActivityFeed,
  projectApprovalCards
} from '../src/lib/viewModels';
import {
  getRegisteredTools,
  registerAllTools,
  resetWebMcpRegistry
} from '../src/lib/webmcp';
import type {
  ActivityLogEntry,
  ActorContext,
  ApprovalCardStatus,
  ApprovalCardSummary
} from '../src/shared/models';
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY
} from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import { TEST_TIMESTAMP } from './factories';

function approvalCard(
  id = 'approval-1',
  status: ApprovalCardStatus = 'pending'
): ApprovalCardSummary {
  return {
    id,
    targetOperation: 'coordinate_interview_workflow',
    requestedBy: { actorType: 'agent', actorId: 'agent-demo' },
    requestedAt: TEST_TIMESTAMP,
    baseRevision: 4,
    affectedRecords: [
      { type: 'Interview', id: 'preview-interview-1', effect: 'create' },
      { type: 'Application', id: 'app-1', effect: 'update' }
    ],
    proposedOutput: {
      applicationId: 'app-1',
      status: 'preview',
      safeImpact: 'three proposed interview slots'
    },
    changeSummary: ['Create Interview preview-interview-1', 'Update Application app-1'],
    warnings: ['Panel availability should be rechecked at commit time.'],
    blockers: ['Human review is required before commit.'],
    requiredCapability: 'interview.coordinate',
    approvalPolicy: 'human',
    policyVersion: 'p11.2.v1',
    status,
    expiresAt: '2099-02-01T00:00:00.000Z',
    correlationId: `correlation-${id}`,
    traceId: `trace-${id}`,
    redactions: ['normalizedInput', 'requestFingerprint', 'targetFingerprint']
  };
}

function approvalActivity(
  id: string,
  output: ActivityLogEntry['output'],
  options: Pick<ActivityLogEntry, 'phase' | 'replayed'> = {}
): ActivityLogEntry {
  return {
    id,
    toolName: options.phase === 'replay' ? 'commit_operation_plan' : 'commit_operation_plan',
    actorType: 'human_ui',
    actorId: 'sarah-recruiter',
    input: { approvalId: 'approval-stale' },
    output,
    timestamp: TEST_TIMESTAMP,
    approvalId: 'approval-stale',
    ...options
  };
}

function projectionWithCards(
  cards: ApprovalCardSummary[],
  activityLog: ActivityLogEntry[] = []
) {
  const projection = serializeSharedState(
    new SharedStateRepository(createSeed()).read()
  );
  return {
    ...projection,
    approvalCards: cards,
    activityLog: [...projection.activityLog, ...activityLog]
  };
}

function renderPanel(): string {
  const initialState = useStore.getInitialState();
  const initialValues = { ...initialState };
  Object.assign(initialState, useStore.getState());
  try {
    return renderToStaticMarkup(createElement(ApprovalCardsPanel));
  } finally {
    Object.assign(initialState, initialValues);
  }
}

afterEach(() => {
  useStore.getState().hydrate(projectionWithCards([]));
  useStore.getState().setRole('recruiter');
  resetWebMcpRegistry();
});

describe('P12.5 human approval-card UI and WebMCP annotations', () => {
  it('projects stale and replayed interaction states without changing persisted card status', () => {
    const stale = projectApprovalCards(
      [approvalCard('approval-stale', 'expired')],
      [
        approvalActivity('activity-stale', {
          error: {
            code: 'CONFLICT_ERROR',
            status: 409,
            message: 'The approval target changed after planning',
            details: {
              reason: 'entity_changed',
              approvalId: 'approval-stale'
            }
          }
        }, { phase: 'commit' })
      ],
      TEST_TIMESTAMP
    )[0];
    const replayed = projectApprovalCards(
      [approvalCard('approval-replay', 'committed')],
      [
        {
          ...approvalActivity('activity-replay', {
            approvalId: 'approval-replay',
            status: 'committed'
          }, { phase: 'replay', replayed: true }),
          approvalId: 'approval-replay'
        }
      ],
      TEST_TIMESTAMP
    )[0];

    expect(stale).toMatchObject({ state: 'stale', stale: true, expired: true });
    expect(stale?.card.status).toBe('expired');
    expect(replayed).toMatchObject({ state: 'replayed', replayed: true });
    expect(replayed?.card.status).toBe('committed');
  });

  it('renders safe redacted impact, every lifecycle state, blockers/warnings, and human actions', () => {
    const cards = [
      approvalCard('approval-pending', 'pending'),
      approvalCard('approval-approved', 'approved'),
      approvalCard('approval-rejected', 'rejected'),
      approvalCard('approval-expired', 'expired'),
      approvalCard('approval-committed', 'committed')
    ];
    useStore.getState().hydrate(projectionWithCards(cards));

    const markup = renderPanel();
    expect(markup).toContain('Human approval cards');
    expect(markup).toContain('Exact target impact');
    expect(markup).toContain('Create Interview preview-interview-1');
    expect(markup).toContain('Panel availability should be rechecked at commit time.');
    expect(markup).toContain('Human review is required before commit.');
    expect(markup).toContain('Safe redacted plan details');
    expect(markup).toContain('Redacted fields: normalizedInput, requestFingerprint, targetFingerprint');
    expect(markup).toContain('data-approval-card-state="pending"');
    expect(markup).toContain('data-approval-card-state="approved"');
    expect(markup).toContain('data-approval-card-state="rejected"');
    expect(markup).toContain('data-approval-card-state="expired"');
    expect(markup).toContain('data-approval-card-state="committed"');
    expect(markup).toContain('data-approval-action="approve"');
    expect(markup).toContain('data-approval-action="reject"');
    expect(markup).toContain('data-approval-action="commit"');
    expect(markup).not.toContain('private normalized input');
  });

  it('does not expose approval buttons for an agent actor', () => {
    useStore.getState().hydrate(projectionWithCards([approvalCard()]));
    const initialState = useStore.getInitialState();
    const initialValues = { ...initialState };
    Object.assign(initialState, useStore.getState());
    try {
      const markup = renderToStaticMarkup(
        createElement(ApprovalCardsPanel, {
          actor: actorContextForAgent('agent-approval-test')
        })
      );
      expect(markup).toContain('data-approval-agent-protection');
      expect(markup).not.toContain('data-approval-action="approve"');
      expect(markup).not.toContain('data-approval-action="reject"');
      expect(markup).not.toContain('data-approval-action="commit"');
    } finally {
      Object.assign(initialState, initialValues);
    }
  });

  it('routes human actions through canonical OperationClient operations and refreshes after each call', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const refreshedActors: ActorContext[] = [];
    const fetcher: FetchLike = async (request, init) => {
      calls.push({ url: String(request), init });
      if (String(request).endsWith('/api/state')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({
        approvalId: 'approval-1',
        status: 'approved',
        approvedBy: actorContextForRole('recruiter'),
        approvedAt: TEST_TIMESTAMP
      }), { status: 200 });
    };
    const client = new OperationClient({
      fetcher,
      refreshState: async (actor) => {
        if (actor) refreshedActors.push(actor);
      }
    });
    const human = actorContextForRole('recruiter');

    await invokeApprovalCardAction(client, 'approve', 'approval-1', human);
    await invokeApprovalCardAction(client, 'reject', 'approval-1', human);
    await invokeApprovalCardAction(client, 'commit', 'approval-1', human);

    expect(calls.map((call) => call.url)).toEqual([
      '/api/operations/approve_operation_plan',
      '/api/operations/reject_operation_plan',
      '/api/operations/commit_operation_plan'
    ]);
    expect(calls.every((call) => {
      const headers = new Headers(call.init?.headers);
      const body = JSON.parse(String(call.init?.body)) as {
        input?: { approvalId?: string };
        metadata?: { idempotencyKey?: string };
      };
      return headers.get('x-actor-type') === 'human_ui' &&
        headers.get('x-actor-id') === 'sarah-recruiter' &&
        body.input?.approvalId === 'approval-1' &&
        body.metadata?.idempotencyKey?.startsWith('client-') === true;
    })).toBe(true);
    expect(refreshedActors).toEqual([human, human, human]);

    const beforeAgentAttempt = calls.length;
    await expect(
      invokeApprovalCardAction(
        client,
        'approve',
        'approval-1',
        actorContextForAgent('agent-approval-test')
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ERROR' });
    expect(calls).toHaveLength(beforeAgentAttempt);
  });

  it('keeps store approval cards immutable and carries activity markers into the feed', () => {
    const card = approvalCard('approval-store');
    const activity = approvalActivity('activity-feed', {
      approvalId: 'approval-store',
      status: 'approved'
    }, { phase: 'approval', replayed: true });
    activity.approvalId = 'approval-store';
    useStore.getState().hydrate(projectionWithCards([card], [activity]));

    const snapshot = useStore.getState().snapshot();
    snapshot.approvalCards![0]!.proposedOutput.safeImpact = 'mutated caller copy';
    expect(useStore.getState().approvalCards[0]?.proposedOutput.safeImpact).toBe(
      'three proposed interview slots'
    );
    expect(projectActivityFeed(useStore.getState().activityLog)[0]).toMatchObject({
      approvalId: 'approval-store',
      phase: 'approval',
      replayed: true
    });
  });

  it('keeps additive annotations identical across native, polyfill, and fallback registration', () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const nativeCalls: Array<{ name: string; annotations: unknown }> = [];
    const polyfillCalls: Array<{ name: string; annotations: unknown }> = [];

    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          modelContext: {
            registerTool: (tool: { name: string; annotations: unknown }) => nativeCalls.push(tool)
          }
        }
      });
      delete (globalThis as { navigator?: unknown }).navigator;
      delete (globalThis as { window?: unknown }).window;
      registerAllTools({ force: true });
      expect(nativeCalls.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
      for (const tool of nativeCalls) {
        expect(tool.annotations).toEqual(OPERATION_REGISTRY[tool.name as typeof OPERATION_NAMES[number]].annotations);
      }

      delete (globalThis as { document?: unknown }).document;
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          modelContext: {
            registerTool: (tool: { name: string; annotations: unknown }) => polyfillCalls.push(tool)
          }
        }
      });
      registerAllTools({ force: true });
      expect(polyfillCalls.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
      for (const tool of polyfillCalls) {
        expect(tool.annotations).toEqual(OPERATION_REGISTRY[tool.name as typeof OPERATION_NAMES[number]].annotations);
      }

      delete (globalThis as { navigator?: unknown }).navigator;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
      registerAllTools({ force: true });
      const fallback = getRegisteredTools();
      expect(fallback.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
      for (const tool of fallback) {
        expect(tool.annotations).toEqual(OPERATION_REGISTRY[tool.name].annotations);
      }
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: unknown }).window;
      resetWebMcpRegistry();
    }
  });
});
