import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import CandidateComparisonPanel from '../src/components/CandidateComparisonPanel';
import WorkflowStatusPanel from '../src/components/WorkflowStatusPanel';
import { actorContextForAgent, actorContextForRole } from '../src/client/actorContext';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { useStore } from '../src/lib/store';
import {
  canonicalReadErrorMessage,
  classifyCanonicalReadError,
  projectCandidateComparison,
  projectWorkflowStatus
} from '../src/lib/viewModels';
import { registerAllTools, resetWebMcpRegistry, WebMcpRuntimeAdapter, type WebMcpRegisteredTool } from '../src/lib/webmcp';
import { PipelineError } from '../src/shared/errors';
import type { ActivityLogEntry, ActorContext, ApplicationRecord, SharedStateProjectionWithCatalogs } from '../src/shared/models';
import type { CompareCandidatesOutput, GetRecruitingWorkflowStatusOutput, OperationName } from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { OperationService } from '../src/server/operationService';
import { defaultOperationHandlers } from '../src/server/operations';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import { createSeededRepositoryClones, TEST_TIMESTAMP } from './factories';

const RECRUITER = actorContextForRole('recruiter');
const AGENT = actorContextForAgent('p13-ui-agent');

function projection(): SharedStateProjectionWithCatalogs {
  return serializeSharedState(new SharedStateRepository(createSeed()).read());
}

function renderWithStore(element: ReactElement): string {
  const initialState = useStore.getInitialState();
  const initialValues = { ...initialState };
  Object.assign(initialState, useStore.getState());
  try {
    return renderToStaticMarkup(element);
  } finally {
    Object.assign(initialState, initialValues);
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function serviceFetch(service: OperationService): FetchLike {
  return async (request, init) => {
    const url = String(request);
    if (url.endsWith('/api/state')) {
      return response(serializeSharedState(service.repository.read()));
    }
    const operationName = url.split('/').at(-1) as OperationName;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown };
    const headers = new Headers(init?.headers);
    const actor: ActorContext = {
      actorType: (headers.get('x-actor-type') ?? 'agent') as ActorContext['actorType'],
      actorId: headers.get('x-actor-id') ?? AGENT.actorId
    };
    try {
      return response(await service.invoke(operationName, body.input as never, actor));
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return response(pipelineError.toPayload(), pipelineError.status);
    }
  };
}

class CapturingAdapter extends WebMcpRuntimeAdapter {
  readonly tools: WebMcpRegisteredTool[] = [];

  override register(tool: WebMcpRegisteredTool): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

function applicationFixture(): ApplicationRecord {
  return {
    id: 'p13-ui-application',
    candidateId: 'cand-1',
    jobId: 'job-1',
    status: 'applied',
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

function repositoriesForParity(): SharedStateRepository[] {
  const seed = createSeed();
  seed.applications = new Map([["p13-ui-application", applicationFixture()]]);
  return createSeededRepositoryClones(3, { seed });
}

afterEach(() => {
  useStore.getState().hydrate(projection());
  useStore.getState().setRole('recruiter');
  resetWebMcpRegistry();
});

describe('P13 comparison/status UI projections', () => {
  it('renders actor-scoped query controls and explicit idle states without local scores or stages', () => {
    useStore.getState().hydrate(projection());
    const markup = renderWithStore(
      <div>
        <CandidateComparisonPanel actor={RECRUITER} />
        <WorkflowStatusPanel actor={RECRUITER} />
      </div>
    );

    expect(markup).toContain('data-p13-comparison');
    expect(markup).toContain('data-comparison-idle');
    expect(markup).toContain('Explainable candidate comparison');
    expect(markup).toContain('data-p13-workflow-status');
    expect(markup).toContain('data-workflow-status-idle');
    expect(markup).toContain('All visible jobs');
    expect(markup).not.toContain('score: 90');
    expect(markup).not.toContain('currentStage:');
  });

  it('keeps canonical comparison/status values immutable and classifies safe error states', () => {
    const comparison: CompareCandidatesOutput = {
      jobId: 'job-1',
      revision: 3,
      candidates: [{
        candidateId: 'cand-1',
        name: 'Alice Chen',
        rank: 1,
        totalScore: 90,
        scoreBreakdown: {
          requirementMatch: { matched: ['TypeScript'], missing: [], score: 100 },
          skillOverlap: { matched: ['typescript'], score: 100 },
          experienceFit: { evidence: 'Candidate reports 8 years.', score: 80 }
        },
        rationale: 'Canonical rationale',
        limitations: ['No protected traits used.']
      }]
    };
    const status: GetRecruitingWorkflowStatusOutput = {
      revision: 4,
      scope: { jobId: 'job-1' },
      countsByApplicationStatus: { applied: 1 },
      applications: [{
        applicationId: 'app-1',
        candidateId: 'cand-1',
        jobId: 'job-1',
        status: 'applied',
        currentStage: 'screening',
        blockers: ['Canonical blocker'],
        nextActions: ['Canonical action']
      }],
      pendingApprovals: [],
      blockers: ['Canonical blocker'],
      nextActions: ['Canonical action'],
      generatedAt: TEST_TIMESTAMP
    };

    const comparisonProjection = projectCandidateComparison(comparison);
    const statusProjection = projectWorkflowStatus(status);
    comparisonProjection.candidates[0]!.scoreBreakdown.requirementMatch.matched.push('mutated');
    statusProjection.applications[0]!.blockers.push('mutated');

    expect(comparison.candidates[0]?.scoreBreakdown.requirementMatch.matched).toEqual(['TypeScript']);
    expect(status.applications[0]?.blockers).toEqual(['Canonical blocker']);
    expect(projectCandidateComparison(comparison).candidates[0]?.totalScore).toBe(90);
    expect(projectWorkflowStatus(status).applications[0]?.currentStage).toBe('screening');

    const denied = new PipelineError('FORBIDDEN_ERROR', 'hidden record', { reason: 'resource_scope' });
    const missing = new PipelineError('NOT_FOUND_ERROR', 'record missing');
    const invalid = new PipelineError('VALIDATION_ERROR', 'bad selector');
    expect(classifyCanonicalReadError(denied)).toBe('denied');
    expect(canonicalReadErrorMessage(denied)).toContain('not permitted');
    expect(classifyCanonicalReadError(missing)).toBe('missing');
    expect(classifyCanonicalReadError(invalid)).toBe('invalid');
  });
});

describe('P13 OperationClient/server/WebMCP parity', () => {
  it('registers P13 tools from the shared registry and keeps read outputs domain-read-only', async () => {
    const [uiRepository, webRepository, serverRepository] = repositoriesForParity();
    const uiService = new OperationService(uiRepository, defaultOperationHandlers);
    const webService = new OperationService(webRepository, defaultOperationHandlers);
    const serverService = new OperationService(serverRepository, defaultOperationHandlers);
    const client = new OperationClient({
      fetcher: serviceFetch(uiService),
      refreshState: async () => undefined
    });
    const webClient = new OperationClient({
      fetcher: serviceFetch(webService),
      refreshState: async () => undefined
    });
    const adapter = new CapturingAdapter();
    registerAllTools({ client: webClient, agentContext: AGENT, adapter, force: true });

    const comparisonInput = { jobId: 'job-1', candidateIds: ['cand-1', 'cand-2'] };
    const statusInput = { jobId: 'job-1', detail: 'full' as const, limit: 50 };
    const uiComparison = await client.invoke('compare_candidates', comparisonInput, AGENT);
    const webComparison = await adapter.tools.find((tool) => tool.name === 'compare_candidates')!.execute(comparisonInput);
    const serverComparison = await serverService.invoke('compare_candidates', comparisonInput, AGENT);
    const uiStatus = await client.invoke('get_recruiting_workflow_status', statusInput, AGENT);
    const webStatus = await adapter.tools.find((tool) => tool.name === 'get_recruiting_workflow_status')!.execute(statusInput);
    const serverStatus = await serverService.invoke('get_recruiting_workflow_status', statusInput, AGENT);

    expect(webComparison).toEqual(uiComparison);
    expect(serverComparison).toEqual(uiComparison);
    expect(webStatus).toEqual(uiStatus);
    expect(serverStatus).toEqual(uiStatus);
    expect(adapter.tools.map((tool) => tool.name)).toContain('compare_candidates');
    expect(adapter.tools.map((tool) => tool.name)).toContain('get_recruiting_workflow_status');
    expect(adapter.tools.find((tool) => tool.name === 'compare_candidates')?.annotations).toMatchObject({
      executionClass: 'read',
      requiresApproval: false
    });
    expect(adapter.tools.find((tool) => tool.name === 'get_recruiting_workflow_status')?.annotations).toMatchObject({
      executionClass: 'read',
      requiresApproval: false
    });

    const before = serializeSharedState(serverRepository.read());
    expect(serverRepository.read().activityLog.every((entry: ActivityLogEntry) => entry.toolName)).toBe(true);
    expect(serializeSharedState(serverRepository.read()).jobs).toEqual(before.jobs);
    expect(serializeSharedState(serverRepository.read()).candidates).toEqual(before.candidates);
  });
});
