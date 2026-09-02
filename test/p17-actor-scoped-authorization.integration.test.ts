import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import {
  SynchronizationController,
  type StateFetch,
  type RevisionEventSource
} from '../src/client/synchronization';
import {
  registerAllTools,
  resetWebMcpRegistry,
  WebMcpRuntimeAdapter,
  type WebMcpRegisteredTool
} from '../src/lib/webmcp';
import { useStore } from '../src/lib/store';
import { PipelineError } from '../src/shared/errors';
import type {
  ActivityLogEntry,
  ActorContext,
  ApprovalCardRecord,
  ApplicationRecord,
  BackgroundCheckRecord,
  BenefitsEnrollmentRecord,
  InterviewRecord,
  JsonObject,
  OfferRecord,
  OnboardingTaskRecord,
  ScorecardRecord,
  SharedStateProjectionWithCatalogs,
  SourcedProspectRecord
} from '../src/shared/models';
import {
  OPERATION_NAMES,
  type OperationName
} from '../src/shared/operations';
import type {
  TrustedActorResolutionInput,
  TrustedActorResolver,
  TrustedPrincipal
} from '../src/server/authorization';
import {
  createAuthorizationPolicy,
  createUnauthenticatedPrincipal,
  createTrustedPrincipal
} from '../src/server/authorization';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import { TEST_TIMESTAMP } from './factories';

const RECRUITER: ActorContext = {
  actorType: 'human_ui',
  actorId: 'matrix-recruiter'
};
const HIRING_MANAGER: ActorContext = {
  actorType: 'human_ui',
  actorId: 'matrix-hiring-manager'
};
const CANDIDATE: ActorContext = {
  actorType: 'human_ui',
  actorId: 'matrix-candidate'
};
const AGENT: ActorContext = {
  actorType: 'agent',
  actorId: 'matrix-agent'
};
const FORGED: ActorContext = {
  actorType: 'human_ui',
  actorId: 'forged-actor'
};

const VISIBLE_APPLICATION_ID = 'matrix-application-visible';
const HIDDEN_APPLICATION_ID = 'matrix-application-hidden';
const VISIBLE_INTERVIEW_ID = 'matrix-interview-visible';
const HIDDEN_INTERVIEW_ID = 'matrix-interview-hidden';
const VISIBLE_OFFER_ID = 'matrix-offer-visible';
const HIDDEN_OFFER_ID = 'matrix-offer-hidden';
const VISIBLE_TASK_ID = 'matrix-task-visible';
const HIDDEN_TASK_ID = 'matrix-task-hidden';
const VISIBLE_BACKGROUND_ID = 'matrix-background-visible';
const HIDDEN_BACKGROUND_ID = 'matrix-background-hidden';
const VISIBLE_BENEFITS_ID = 'matrix-benefits-visible';
const HIDDEN_BENEFITS_ID = 'matrix-benefits-hidden';
const VISIBLE_PROSPECT_ID = 'matrix-prospect-visible';
const HIDDEN_PROSPECT_ID = 'matrix-prospect-hidden';
const VISIBLE_APPROVAL_ID = 'matrix-approval-visible';
const HIDDEN_APPROVAL_ID = 'matrix-approval-hidden';
const HIDDEN_JOB_ID = 'matrix-job-hidden';
const HIDDEN_PANEL_ID = 'matrix-panel-hidden';

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

class MatrixActorResolver implements TrustedActorResolver {
  constructor(private readonly principals: ReadonlyMap<string, TrustedPrincipal>) {}

  resolve(input: TrustedActorResolutionInput = {}): TrustedPrincipal {
    const actorType = input.headers?.['x-actor-type'];
    const actorId = input.headers?.['x-actor-id'];
    const key =
      typeof actorType === 'string' && typeof actorId === 'string'
        ? `${actorType}:${actorId}`
        : undefined;
    return key === undefined
      ? createUnauthenticatedPrincipal('missing_principal')
      : this.principals.get(key) ??
          createUnauthenticatedPrincipal('unknown_demo_actor');
  }
}

class MatrixEventSource implements RevisionEventSource {
  private readonly listeners = new Set<(event: MessageEvent<string>) => void>();
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void
  ): void {
    if (type === 'state_changed') this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void
  ): void {
    if (type === 'state_changed') this.listeners.delete(listener);
  }

  emit(revision: number): void {
    const event = {
      data: JSON.stringify({ type: 'state_changed', revision })
    } as MessageEvent<string>;
    for (const listener of this.listeners) listener(event);
    this.onmessage?.(event);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

function actorHeaders(actor: ActorContext): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-actor-type': actor.actorType,
    'x-actor-id': actor.actorId
  };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  actor: ActorContext,
  body?: unknown
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: actorHeaders(actor),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
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

function operationRequest(
  baseUrl: string,
  name: OperationName,
  input: unknown,
  actor: ActorContext
): Promise<HttpResult> {
  return request(
    baseUrl,
    'POST',
    `/api/operations/${name}`,
    actor,
    { input }
  );
}

function application(
  id: string,
  candidateId: string,
  jobId: string,
  status: ApplicationRecord['status'] = 'offer_accepted'
): ApplicationRecord {
  return {
    id,
    candidateId,
    jobId,
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

function offer(
  id: string,
  applicationId: string,
  status: OfferRecord['status'] = 'accepted'
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

function interview(
  id: string,
  applicationId: string,
  panelId: string
): InterviewRecord {
  return {
    id,
    applicationId,
    panelId,
    slot: '2026-09-01T10:00:00Z',
    status: 'booked'
  };
}

function scorecard(id: string, interviewId: string): ScorecardRecord {
  return {
    id,
    interviewId,
    interviewer: 'interviewer-1',
    competencyScores: { reliability: 4 },
    recommendation: 'yes',
    comments: 'Safe visible feedback',
    submittedAt: TEST_TIMESTAMP
  };
}

function onboardingTask(
  id: string,
  offerId: string,
  status: OnboardingTaskRecord['status'] = 'pending'
): OnboardingTaskRecord {
  return {
    id,
    offerId,
    taskName: 'Complete onboarding task',
    status,
    dueDate: '2026-09-07T09:00:00.000Z'
  };
}

function backgroundCheck(id: string, offerId: string): BackgroundCheckRecord {
  return {
    id,
    offerId,
    status: 'clear',
    initiatedAt: TEST_TIMESTAMP,
    completedAt: TEST_TIMESTAMP
  };
}

function benefitsEnrollment(id: string, offerId: string): BenefitsEnrollmentRecord {
  return {
    id,
    offerId,
    planSelections: {
      medical: 'medical-basic',
      dental: 'dental-basic',
      vision: 'vision-basic'
    },
    enrolledAt: TEST_TIMESTAMP
  };
}

function sourcedProspect(
  id: string,
  candidateId: string
): SourcedProspectRecord {
  return {
    id,
    source: 'github',
    sourceRecordId: `${id}-source-record`,
    profileUrl: `https://github.com/${id}`,
    canonicalSourceUrl: `https://api.github.com/users/${id}`,
    sourceQuery: 'backend engineer',
    sourceFilters: { language: 'TypeScript', location: 'Berlin' },
    fetchedAt: TEST_TIMESTAMP,
    importedAt: TEST_TIMESTAMP,
    dataOrigin: 'public_github',
    consentStatus: 'explicit',
    consent: {
      method: 'approved_consent_channel',
      scope: 'candidate profile import',
      capturedAt: TEST_TIMESTAMP,
      capturedBy: RECRUITER,
      evidenceRef: `${id}-consent-reference`,
      policyVersion: 'p11.2.v1'
    },
    fieldOrigins: {
      sourceRecordId: 'github_public',
      name: 'candidate_submitted'
    },
    attribution: {
      source: 'github',
      apiUrl: 'https://api.github.com',
      searchApiDocsUrl: 'https://docs.github.com/rest/search',
      rateLimitsDocsUrl: 'https://docs.github.com/rest/using-the-rest-api/rate-limits',
      userApiDocsUrl: 'https://docs.github.com/rest/users/users'
    },
    retentionExpiresAt: '2099-01-01T00:00:00.000Z',
    candidateId
  };
}

function approvalCard(
  id: string,
  applicationId: string,
  requestedBy: ActorContext
): ApprovalCardRecord {
  return {
    id,
    targetOperation: 'coordinate_interview_workflow',
    normalizedInput: {
      applicationId,
      action: 'propose_slots',
      privateContact: 'must not project'
    },
    requestFingerprint: `${id}-request-fingerprint`,
    requestedBy,
    requestedAt: TEST_TIMESTAMP,
    baseRevision: 1,
    targetFingerprint: `${id}-target-fingerprint`,
    affectedRecords: [
      { type: 'Application', id: applicationId, effect: 'update' }
    ],
    proposedOutput: {
      applicationId,
      safeImpact: 'Propose interview slots',
      requestFingerprint: 'must not project'
    },
    changeSummary: [`Update ${applicationId}`],
    warnings: ['Panel availability should be rechecked.'],
    blockers: ['Human review is required.'],
    requiredCapability: 'interview.coordinate',
    approvalPolicy: 'human',
    policyVersion: 'p11.2.v1',
    status: 'pending',
    expiresAt: '2099-01-01T00:00:00.000Z',
    correlationId: `${id}-correlation`,
    traceId: `${id}-trace`
  };
}

function activity(
  id: string,
  actor: ActorContext,
  input: JsonObject,
  output: JsonObject
): ActivityLogEntry {
  return {
    id,
    toolName: 'coordinate_interview_workflow',
    actorType: actor.actorType,
    actorId: actor.actorId,
    input,
    output,
    timestamp: TEST_TIMESTAMP,
    correlationId: `${id}-correlation`,
    traceId: `${id}-trace`,
    spanId: `${id}-span`,
    trace: {
      spans: [
        {
          spanId: `${id}-span`,
          name: 'coordinate_interview_workflow',
          status: 'completed',
          startedAt: TEST_TIMESTAMP,
          completedAt: TEST_TIMESTAMP,
          summary: { safe: 'bounded trace summary' }
        }
      ]
    }
  };
}

function matrixSeed() {
  const seed = createSeed();
  const hiddenJob = {
    ...seed.jobs.get('job-1')!,
    id: HIDDEN_JOB_ID,
    title: 'Hidden requisition',
    status: 'closed' as const,
    createdBy: 'other-recruiter'
  };
  seed.jobs.set(hiddenJob.id, hiddenJob);

  const hiddenCandidate = {
    ...seed.candidates.get('cand-3')!,
    email: 'private.hidden@example.test'
  };
  seed.candidates.set(hiddenCandidate.id, hiddenCandidate);

  seed.panels.set(HIDDEN_PANEL_ID, {
    id: HIDDEN_PANEL_ID,
    jobId: HIDDEN_JOB_ID,
    interviewers: [
      { id: 'hidden-interviewer', name: 'Hidden Interviewer', role: 'Reviewer' }
    ]
  });
  seed.applications = new Map([
    [
      VISIBLE_APPLICATION_ID,
      application(VISIBLE_APPLICATION_ID, 'cand-1', 'job-1')
    ],
    [
      HIDDEN_APPLICATION_ID,
      application(HIDDEN_APPLICATION_ID, 'cand-3', HIDDEN_JOB_ID)
    ]
  ]);
  seed.interviews = new Map([
    [
      VISIBLE_INTERVIEW_ID,
      interview(VISIBLE_INTERVIEW_ID, VISIBLE_APPLICATION_ID, 'panel-1')
    ],
    [
      HIDDEN_INTERVIEW_ID,
      interview(HIDDEN_INTERVIEW_ID, HIDDEN_APPLICATION_ID, HIDDEN_PANEL_ID)
    ]
  ]);
  seed.scorecards = new Map([
    [
      'matrix-scorecard-visible',
      scorecard('matrix-scorecard-visible', VISIBLE_INTERVIEW_ID)
    ],
    [
      'matrix-scorecard-hidden',
      scorecard('matrix-scorecard-hidden', HIDDEN_INTERVIEW_ID)
    ]
  ]);
  seed.offers = new Map([
    [VISIBLE_OFFER_ID, offer(VISIBLE_OFFER_ID, VISIBLE_APPLICATION_ID)],
    [HIDDEN_OFFER_ID, offer(HIDDEN_OFFER_ID, HIDDEN_APPLICATION_ID)]
  ]);
  seed.onboardingTasks = new Map([
    [VISIBLE_TASK_ID, onboardingTask(VISIBLE_TASK_ID, VISIBLE_OFFER_ID)],
    [HIDDEN_TASK_ID, onboardingTask(HIDDEN_TASK_ID, HIDDEN_OFFER_ID)]
  ]);
  seed.backgroundChecks = new Map([
    [VISIBLE_BACKGROUND_ID, backgroundCheck(VISIBLE_BACKGROUND_ID, VISIBLE_OFFER_ID)],
    [HIDDEN_BACKGROUND_ID, backgroundCheck(HIDDEN_BACKGROUND_ID, HIDDEN_OFFER_ID)]
  ]);
  seed.benefitsEnrollments = new Map([
    [VISIBLE_BENEFITS_ID, benefitsEnrollment(VISIBLE_BENEFITS_ID, VISIBLE_OFFER_ID)],
    [HIDDEN_BENEFITS_ID, benefitsEnrollment(HIDDEN_BENEFITS_ID, HIDDEN_OFFER_ID)]
  ]);
  seed.sourcedProspects = new Map([
    [VISIBLE_PROSPECT_ID, sourcedProspect(VISIBLE_PROSPECT_ID, 'cand-1')],
    [HIDDEN_PROSPECT_ID, sourcedProspect(HIDDEN_PROSPECT_ID, 'cand-3')]
  ]);
  seed.approvalCards = new Map([
    [
      VISIBLE_APPROVAL_ID,
      approvalCard(VISIBLE_APPROVAL_ID, VISIBLE_APPLICATION_ID, AGENT)
    ],
    [
      HIDDEN_APPROVAL_ID,
      approvalCard(HIDDEN_APPROVAL_ID, HIDDEN_APPLICATION_ID, {
        actorType: 'human_ui',
        actorId: 'other-requester'
      })
    ]
  ]);
  seed.activityLog = [
    activity(
      'matrix-activity-visible',
      { actorType: 'agent', actorId: 'other-agent' },
      { applicationId: VISIBLE_APPLICATION_ID },
      { status: 'visible' }
    ),
    activity(
      'matrix-activity-hidden',
      { actorType: 'agent', actorId: 'other-agent' },
      { applicationId: HIDDEN_APPLICATION_ID },
      { status: 'hidden' }
    ),
    activity(
      'matrix-activity-candidate-own',
      CANDIDATE,
      { safe: 'actor-owned activity' },
      { status: 'owned' }
    )
  ];
  return seed;
}

function matrixPrincipals(): ReadonlyMap<string, TrustedPrincipal> {
  const recruiter = createTrustedPrincipal({
    actor: RECRUITER,
    role: 'recruiter',
    resourceScopes: [
      { resourceType: 'job', mode: 'assigned', resourceIds: ['job-1'] },
      {
        resourceType: 'candidate',
        mode: 'assigned',
        resourceIds: ['cand-1', 'cand-2']
      },
      {
        resourceType: 'application',
        mode: 'assigned',
        resourceIds: [VISIBLE_APPLICATION_ID]
      },
      { resourceType: 'panel', mode: 'assigned', resourceIds: ['panel-1'] },
      {
        resourceType: 'interview',
        mode: 'assigned',
        resourceIds: [VISIBLE_INTERVIEW_ID]
      },
      {
        resourceType: 'offer',
        mode: 'assigned',
        resourceIds: [VISIBLE_OFFER_ID]
      },
      {
        resourceType: 'onboarding',
        mode: 'assigned',
        resourceIds: [VISIBLE_TASK_ID]
      },
      {
        resourceType: 'prospect',
        mode: 'assigned',
        resourceIds: [VISIBLE_PROSPECT_ID]
      },
      {
        resourceType: 'approval',
        mode: 'assigned',
        resourceIds: [VISIBLE_APPROVAL_ID]
      }
    ],
    approvalCapabilities: [
      'workflow.approval.approve',
      'workflow.approval.reject',
      'workflow.plan.commit'
    ]
  });
  const hiringManager = createTrustedPrincipal({
    actor: HIRING_MANAGER,
    role: 'hiring_manager',
    resourceScopes: [
      { resourceType: 'job', mode: 'assigned', resourceIds: ['job-1'] },
      {
        resourceType: 'candidate',
        mode: 'assigned',
        resourceIds: ['cand-1', 'cand-2']
      },
      {
        resourceType: 'application',
        mode: 'assigned',
        resourceIds: [VISIBLE_APPLICATION_ID]
      },
      { resourceType: 'panel', mode: 'assigned', resourceIds: ['panel-1'] },
      {
        resourceType: 'interview',
        mode: 'assigned',
        resourceIds: [VISIBLE_INTERVIEW_ID]
      }
    ]
  });
  const candidate = createTrustedPrincipal({
    actor: CANDIDATE,
    role: 'candidate',
    resourceScopes: [
      {
        resourceType: 'candidate',
        mode: 'self',
        resourceIds: ['cand-1'],
        subjectId: 'cand-1'
      },
      { resourceType: 'application', mode: 'self', subjectId: 'cand-1' },
      { resourceType: 'offer', mode: 'self', subjectId: 'cand-1' },
      { resourceType: 'onboarding', mode: 'self', subjectId: 'cand-1' }
    ]
  });
  const agent = createTrustedPrincipal({
    actor: AGENT,
    role: 'agent',
    capabilities: [
      'capabilities.discover',
      'state.read',
      'state.events',
      'candidate.compare',
      'workflow.plan',
      'interview.coordinate',
      'onboarding.coordinate',
      'pipeline.operation.get_candidate_profile',
      'pipeline.operation.get_onboarding_status'
    ],
    resourceScopes: [
      { resourceType: 'job', mode: 'delegated', resourceIds: ['job-1'] },
      {
        resourceType: 'candidate',
        mode: 'delegated',
        resourceIds: ['cand-1']
      },
      {
        resourceType: 'application',
        mode: 'delegated',
        resourceIds: [VISIBLE_APPLICATION_ID]
      },
      { resourceType: 'panel', mode: 'delegated', resourceIds: ['panel-1'] },
      {
        resourceType: 'interview',
        mode: 'delegated',
        resourceIds: [VISIBLE_INTERVIEW_ID]
      },
      {
        resourceType: 'offer',
        mode: 'delegated',
        resourceIds: [VISIBLE_OFFER_ID]
      },
      {
        resourceType: 'onboarding',
        mode: 'delegated',
        resourceIds: [VISIBLE_TASK_ID]
      },
      {
        resourceType: 'prospect',
        mode: 'delegated',
        resourceIds: [VISIBLE_PROSPECT_ID]
      }
    ]
  });
  return new Map([
    [`${RECRUITER.actorType}:${RECRUITER.actorId}`, recruiter],
    [`${HIRING_MANAGER.actorType}:${HIRING_MANAGER.actorId}`, hiringManager],
    [`${CANDIDATE.actorType}:${CANDIDATE.actorId}`, candidate],
    [`${AGENT.actorType}:${AGENT.actorId}`, agent]
  ]);
}

async function startMatrixApi(): Promise<RunningApi> {
  const contextRepository = new SharedStateRepository(matrixSeed());
  const policy = createAuthorizationPolicy({ environment: 'test' });
  const api = createPipelineApi({
    repository: contextRepository,
    handlers: defaultOperationHandlers,
    trustedActorResolver: new MatrixActorResolver(matrixPrincipals()),
    authorizationPolicy: policy,
    environment: 'test'
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

function ids<T extends { id: string }>(values: readonly T[]): string[] {
  return values.map((value) => value.id);
}

function expectNoHiddenIdentifiers(state: SharedStateProjectionWithCatalogs): void {
  const serialized = JSON.stringify(state);
  for (const hiddenId of [
    HIDDEN_JOB_ID,
    HIDDEN_PANEL_ID,
    HIDDEN_APPLICATION_ID,
    HIDDEN_INTERVIEW_ID,
    HIDDEN_OFFER_ID,
    HIDDEN_TASK_ID,
    HIDDEN_BACKGROUND_ID,
    HIDDEN_BENEFITS_ID,
    HIDDEN_PROSPECT_ID,
    HIDDEN_APPROVAL_ID
  ]) {
    expect(serialized).not.toContain(hiddenId);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Timed out waiting for synchronized state'));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
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
      return fetch(`${running.baseUrl}/api/state`, {
        headers: actorHeaders(refreshedActor ?? actor)
      }).then(async (response) => response.json());
    }
  });
}

afterEach(() => {
  resetWebMcpRegistry();
  useStore.getState().setRole('recruiter');
  useStore.getState().hydrate({
    revision: 0,
    jobs: [],
    candidates: [],
    applications: [],
    panels: [],
    interviews: [],
    scorecards: [],
    offers: [],
    onboardingTasks: [],
    backgroundChecks: [],
    benefitsEnrollments: [],
    approvalCards: [],
    sourcedProspects: [],
    activityLog: [],
    catalogs: {
      availabilityCalendar: [],
      roleTemplates: [],
      planCatalog: { medical: [], dental: [], vision: [] },
      startDate: ''
    }
  });
});

describe('P17 actor-scoped state and route authorization', () => {
  it('filters every state collection, activity trace, and catalog by resource scope', async () => {
    const running = await startMatrixApi();
    try {
      const recruiter = (await request(
        running.baseUrl,
        'GET',
        '/api/state',
        RECRUITER
      )).body as SharedStateProjectionWithCatalogs;
      expect(ids(recruiter.jobs)).toEqual(['job-1']);
      expect(ids(recruiter.candidates)).toEqual(['cand-1', 'cand-2']);
      expect(ids(recruiter.applications)).toEqual([VISIBLE_APPLICATION_ID]);
      expect(ids(recruiter.panels)).toEqual(['panel-1']);
      expect(ids(recruiter.interviews)).toEqual([VISIBLE_INTERVIEW_ID]);
      expect(ids(recruiter.scorecards)).toEqual(['matrix-scorecard-visible']);
      expect(ids(recruiter.offers)).toEqual([VISIBLE_OFFER_ID]);
      expect(ids(recruiter.onboardingTasks)).toEqual([VISIBLE_TASK_ID]);
      expect(ids(recruiter.backgroundChecks)).toEqual([VISIBLE_BACKGROUND_ID]);
      expect(ids(recruiter.benefitsEnrollments)).toEqual([VISIBLE_BENEFITS_ID]);
      expect(ids(recruiter.approvalCards)).toEqual([VISIBLE_APPROVAL_ID]);
      expect(ids(recruiter.sourcedProspects ?? [])).toEqual([VISIBLE_PROSPECT_ID]);
      expect(ids(recruiter.activityLog)).toEqual(['matrix-activity-visible']);
      expect(recruiter.catalogs.availabilityCalendar).toHaveLength(3);
      expectNoHiddenIdentifiers(recruiter);

      const hiringManager = (await request(
        running.baseUrl,
        'GET',
        '/api/state',
        HIRING_MANAGER
      )).body as SharedStateProjectionWithCatalogs;
      expect(ids(hiringManager.jobs)).toEqual(['job-1']);
      expect(ids(hiringManager.candidates)).toEqual(['cand-1', 'cand-2']);
      expect(ids(hiringManager.applications)).toEqual([VISIBLE_APPLICATION_ID]);
      expect(ids(hiringManager.panels)).toEqual(['panel-1']);
      expect(ids(hiringManager.interviews)).toEqual([VISIBLE_INTERVIEW_ID]);
      expect(ids(hiringManager.scorecards)).toEqual(['matrix-scorecard-visible']);
      expect(hiringManager.offers).toEqual([]);
      expect(hiringManager.onboardingTasks).toEqual([]);
      expect(hiringManager.backgroundChecks).toEqual([]);
      expect(hiringManager.benefitsEnrollments).toEqual([]);
      expect(hiringManager.approvalCards).toEqual([]);
      expect(hiringManager.sourcedProspects).toEqual([]);
      expect(ids(hiringManager.activityLog)).toEqual(['matrix-activity-visible']);
      expectNoHiddenIdentifiers(hiringManager);

      const candidate = (await request(
        running.baseUrl,
        'GET',
        '/api/state',
        CANDIDATE
      )).body as SharedStateProjectionWithCatalogs;
      expect(ids(candidate.jobs)).toEqual(['job-1']);
      expect(ids(candidate.candidates)).toEqual(['cand-1']);
      expect(ids(candidate.applications)).toEqual([VISIBLE_APPLICATION_ID]);
      expect(candidate.panels).toEqual([]);
      expect(ids(candidate.interviews)).toEqual([VISIBLE_INTERVIEW_ID]);
      expect(candidate.scorecards).toEqual([]);
      expect(ids(candidate.offers)).toEqual([VISIBLE_OFFER_ID]);
      expect(ids(candidate.onboardingTasks)).toEqual([VISIBLE_TASK_ID]);
      expect(ids(candidate.backgroundChecks)).toEqual([VISIBLE_BACKGROUND_ID]);
      expect(ids(candidate.benefitsEnrollments)).toEqual([VISIBLE_BENEFITS_ID]);
      expect(candidate.approvalCards).toEqual([]);
      expect(candidate.sourcedProspects).toEqual([]);
      expect(ids(candidate.activityLog)).toEqual([
        'matrix-activity-visible',
        'matrix-activity-candidate-own'
      ]);
      expect(candidate.catalogs.availabilityCalendar).toEqual([]);
      expectNoHiddenIdentifiers(candidate);

      const agent = (await request(
        running.baseUrl,
        'GET',
        '/api/state',
        AGENT
      )).body as SharedStateProjectionWithCatalogs;
      expect(ids(agent.jobs)).toEqual(['job-1']);
      expect(ids(agent.candidates)).toEqual(['cand-1']);
      expect(ids(agent.applications)).toEqual([VISIBLE_APPLICATION_ID]);
      expect(ids(agent.panels)).toEqual(['panel-1']);
      expect(ids(agent.interviews)).toEqual([VISIBLE_INTERVIEW_ID]);
      expect(ids(agent.scorecards)).toEqual(['matrix-scorecard-visible']);
      expect(ids(agent.offers)).toEqual([VISIBLE_OFFER_ID]);
      expect(ids(agent.onboardingTasks)).toEqual([VISIBLE_TASK_ID]);
      expect(ids(agent.backgroundChecks)).toEqual([VISIBLE_BACKGROUND_ID]);
      expect(ids(agent.benefitsEnrollments)).toEqual([VISIBLE_BENEFITS_ID]);
      expect(ids(agent.approvalCards)).toEqual([VISIBLE_APPROVAL_ID]);
      expect(ids(agent.sourcedProspects ?? [])).toEqual([VISIBLE_PROSPECT_ID]);
      expect(ids(agent.activityLog)).toContain('matrix-activity-visible');
      expectNoHiddenIdentifiers(agent);
    } finally {
      await running.close();
    }
  });

  it('fails closed for forged actors, restricts reset, and authorizes events only for trusted actors', async () => {
    const running = await startMatrixApi();
    try {
      const forgedState = await request(
        running.baseUrl,
        'GET',
        '/api/state',
        FORGED
      );
      expect(forgedState.status).toBe(403);
      expect(JSON.stringify(forgedState.body)).not.toContain('matrix-application-visible');
      expect((forgedState.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'not_authenticated'
      );

      const unknownEvents = await request(
        running.baseUrl,
        'GET',
        '/api/events',
        FORGED
      );
      expect(unknownEvents.status).toBe(403);

      const candidateReset = await request(
        running.baseUrl,
        'POST',
        '/api/reset',
        CANDIDATE,
        {}
      );
      expect(candidateReset.status).toBe(403);
      const agentReset = await request(
        running.baseUrl,
        'POST',
        '/api/reset',
        AGENT,
        {}
      );
      expect(agentReset.status).toBe(403);

      const candidateEvents = await fetch(`${running.baseUrl}/api/events`, {
        headers: actorHeaders(CANDIDATE)
      });
      expect(candidateEvents.status).toBe(200);
      expect(candidateEvents.headers.get('content-type')).toContain('text/event-stream');
      await candidateEvents.body?.cancel();

      const beforeReset = running.api.repository.getRevision();
      const recruiterReset = await request(
        running.baseUrl,
        'POST',
        '/api/reset',
        RECRUITER,
        {}
      );
      expect(recruiterReset.status).toBe(200);
      expect((recruiterReset.body as { success: boolean }).success).toBe(true);
      expect(running.api.repository.getRevision()).toBeGreaterThan(beforeReset);
    } finally {
      await running.close();
    }
  });
});

describe('P17 capability, OperationClient, WebMCP, and synchronization parity', () => {
  it('keeps manifests informational while execute-time policy denies hidden and approval-only actions', async () => {
    const running = await startMatrixApi();
    try {
      const agentRefreshActors: ActorContext[] = [];
      const agentClient = operationClientFor(running, AGENT, agentRefreshActors);
      const agentManifest = await agentClient.discoverCapabilities(AGENT);
      expect(agentManifest.actor).toEqual(AGENT);
      expect(agentManifest.capabilities).toHaveLength(OPERATION_NAMES.length);
      const agentProfile = agentManifest.capabilities.find(
        (entry) => entry.name === 'get_candidate_profile'
      )!;
      expect(agentProfile.visible).toBe(true);
      expect(agentProfile.allowed).toBe(true);
      expect(agentProfile.resourceScope).toBe('candidate:delegated');
      const agentCoordinator = agentManifest.capabilities.find(
        (entry) => entry.name === 'coordinate_interview_workflow'
      )!;
      expect(agentCoordinator.visible).toBe(true);
      expect(agentCoordinator.allowed).toBe(false);
      expect(agentCoordinator.requiresApproval).toBe(true);
      expect(agentCoordinator.denialReason).toBe('approval_only');
      const agentApproval = agentManifest.capabilities.find(
        (entry) => entry.name === 'approve_operation_plan'
      )!;
      expect(agentApproval.visible).toBe(false);
      expect(agentApproval.allowed).toBe(false);
      expect(agentApproval.denialReason).toBe('capability_denied');
      expect(JSON.stringify(agentManifest)).not.toContain(HIDDEN_APPLICATION_ID);
      expect(JSON.stringify(agentManifest)).not.toContain('implementationKey');

      const profile = await agentClient.invoke(
        'get_candidate_profile',
        { candidateId: 'cand-1' },
        { actor: AGENT }
      );
      expect(profile.id).toBe('cand-1');
      await expect(
        agentClient.invoke(
          'get_candidate_profile',
          { candidateId: 'cand-3' },
          { actor: AGENT }
        )
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_ERROR',
        status: 403,
        details: { reason: 'resource_scope' }
      });
      await expect(
        agentClient.invoke(
          'approve_operation_plan',
          { approvalId: VISIBLE_APPROVAL_ID },
          {
            actor: AGENT,
            metadata: { idempotencyKey: 'matrix-agent-approval-denial' }
          }
        )
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_ERROR',
        status: 403,
        details: { reason: 'capability_denied' }
      });
      expect(agentRefreshActors).toEqual([AGENT, AGENT, AGENT, AGENT]);

      const candidateClient = operationClientFor(running, CANDIDATE);
      const candidateManifest = await candidateClient.discoverCapabilities(CANDIDATE);
      const candidateSearch = candidateManifest.capabilities.find(
        (entry) => entry.name === 'search_candidates'
      )!;
      expect(candidateSearch.visible).toBe(false);
      expect(candidateSearch.allowed).toBe(false);
      expect(candidateSearch.denialReason).toBe('capability_denied');
      const candidateProfile = candidateManifest.capabilities.find(
        (entry) => entry.name === 'get_candidate_profile'
      )!;
      expect(candidateProfile.allowed).toBe(true);
      expect(candidateProfile.resourceScope).toBe('candidate:self');
      expect(JSON.stringify(candidateManifest)).not.toContain(HIDDEN_PROSPECT_ID);
    } finally {
      await running.close();
    }
  });

  it('registers the exact shared WebMCP registry with safe capability metadata and canonical errors', async () => {
    const running = await startMatrixApi();
    try {
      const client = operationClientFor(running, AGENT);
      const adapter = new CapturingAdapter();
      registerAllTools({
        client,
        agentContext: AGENT,
        adapter,
        force: true
      });
      expect(adapter.tools).toHaveLength(OPERATION_NAMES.length);
      const coordinator = adapter.tools.find(
        (tool) => tool.name === 'coordinate_interview_workflow'
      )!;
      expect(coordinator.requiredCapability).toBe('interview.coordinate');
      expect(coordinator.approvalPolicy).toBe('human');
      expect(coordinator.annotations).toMatchObject({
        executionClass: 'commit',
        requiresApproval: true
      });
      const approval = adapter.tools.find(
        (tool) => tool.name === 'approve_operation_plan'
      )!;
      await expect(
        approval.execute({ approvalId: VISIBLE_APPROVAL_ID })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_ERROR',
        status: 403,
        details: { reason: 'capability_denied' }
      });
      expect(JSON.stringify(adapter.tools)).not.toContain('implementationKey');
      expect(JSON.stringify(adapter.tools)).not.toContain(HIDDEN_APPLICATION_ID);
    } finally {
      await running.close();
    }
  });

  it('refreshes actor-scoped projections and connects SSE under the same actor', async () => {
    const running = await startMatrixApi();
    const calls: Array<{ url: string; headers: Headers }> = [];
    let source: MatrixEventSource | undefined;
    const fetcher: StateFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), headers });
      return fetch(input, init);
    };
    const controller = new SynchronizationController({
      baseUrl: running.baseUrl,
      fetcher,
      actor: CANDIDATE,
      eventSourceFactory: (url) => {
        source = new MatrixEventSource();
        calls.push({ url, headers: new Headers() });
        return source;
      }
    });

    try {
      await controller.start();
      expect(useStore.getState().candidates.map((candidate) => candidate.id)).toEqual([
        'cand-1'
      ]);
      expect(useStore.getState().panels).toEqual([]);
      expect(useStore.getState().activityLog.map((entry) => entry.id)).toEqual([
        'matrix-activity-visible',
        'matrix-activity-candidate-own'
      ]);
      const stateCalls = calls.filter((call) => call.url.endsWith('/api/state'));
      expect(stateCalls.length).toBeGreaterThanOrEqual(1);
      expect(
        stateCalls.every(
          (call) =>
            call.headers.get('x-actor-type') === CANDIDATE.actorType &&
            call.headers.get('x-actor-id') === CANDIDATE.actorId
        )
      ).toBe(true);
      const eventCall = calls.find((call) => call.url.includes('/api/events?'))!;
      const eventUrl = new URL(eventCall.url);
      expect(eventUrl.searchParams.get('actorType')).toBe(CANDIDATE.actorType);
      expect(eventUrl.searchParams.get('actorId')).toBe(CANDIDATE.actorId);
      expect(source).toBeDefined();

      running.api.repository.reset();
      const nextRevision = running.api.repository.getRevision();
      source!.emit(nextRevision);
      await waitFor(() => useStore.getState().revision === nextRevision);
      expect(useStore.getState().candidates.map((candidate) => candidate.id)).toEqual([
        'cand-1'
      ]);
      expect(useStore.getState().panels).toEqual([]);
      expect(
        calls
          .filter((call) => call.url.endsWith('/api/state'))
          .every(
            (call) =>
              call.headers.get('x-actor-type') === CANDIDATE.actorType &&
              call.headers.get('x-actor-id') === CANDIDATE.actorId
          )
      ).toBe(true);
    } finally {
      controller.stop();
      await running.close();
    }
  });
});
