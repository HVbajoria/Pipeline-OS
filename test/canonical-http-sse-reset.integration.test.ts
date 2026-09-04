import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import type {
  ActorContext,
  SharedStateProjectionWithCatalogs
} from '../src/shared/models';
import { type OperationName } from '../src/shared/operations';
import { defaultOperationHandlers } from '../src/server/operations';
import { redactJsonObject } from '../src/shared/domain/redaction';
import { createTestContext, DeterministicIdGenerator, TEST_TIMESTAMP } from './factories';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface TestServer {
  app: Express;
  api: PipelineApi;
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

interface StateChangedEvent {
  type: 'state_changed';
  revision: number;
}

interface SseConnection {
  headers: Record<string, string | string[] | undefined>;
  readonly received: readonly StateChangedEvent[];
  waitForRevision(revision: number): Promise<StateChangedEvent>;
  close(): Promise<void>;
}

const humanActor: ActorContext = {
  actorType: 'human_ui',
  actorId: 'http-human'
};
const agentActor: ActorContext = {
  actorType: 'agent',
  actorId: 'http-agent'
};

/** The pre-agentic operation set exercised by this legacy HTTP workflow. */
const LEGACY_OPERATION_NAMES = [
  'create_job_requisition',
  'search_candidates',
  'get_candidate_profile',
  'submit_application',
  'screen_candidate',
  'answer_candidate_faq',
  'check_interviewer_availability',
  'propose_interview_slots',
  'book_interview',
  'get_interview_kit',
  'submit_interview_feedback',
  'get_panel_feedback_summary',
  'generate_offer',
  'send_offer',
  'respond_to_offer',
  'initiate_background_check',
  'enroll_benefits',
  'generate_onboarding_checklist',
  'get_onboarding_status'
] as const satisfies readonly OperationName[];

function actorFor(index: number): ActorContext {
  return index % 2 === 0 ? humanActor : agentActor;
}

function jsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload).toString()
              }),
          ...headers
        }
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            // Keep non-JSON content visible to the assertion instead of hiding
            // an accidental HTML/Vite response behind a parser failure.
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsed
          });
        });
      }
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function openSse(baseUrl: string): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/events', baseUrl);
    let settled = false;
    let response: IncomingMessage | undefined;
    let buffer = '';
    const received: StateChangedEvent[] = [];
    const waiters: Array<{
      revision: number;
      resolve: (event: StateChangedEvent) => void;
    }> = [];

    const publish = (event: StateChangedEvent): void => {
      received.push(event);
      const waiterIndex = waiters.findIndex(
        (waiter) => waiter.revision === event.revision
      );
      if (waiterIndex >= 0) {
        const [{ resolve: resolveWaiter }] = waiters.splice(waiterIndex, 1);
        resolveWaiter(event);
      }
    };

    const request: ClientRequest = httpRequest(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname
      },
      (incomingResponse) => {
        response = incomingResponse;
        if (incomingResponse.statusCode !== 200) {
          incomingResponse.resume();
          reject(new Error(`SSE request returned ${incomingResponse.statusCode}`));
          return;
        }

        incomingResponse.setEncoding('utf8');
        incomingResponse.on('data', (chunk: string) => {
          buffer += chunk;
          let frameEnd = buffer.indexOf('\n\n');
          while (frameEnd >= 0) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            frameEnd = buffer.indexOf('\n\n');

            const eventName = frame.match(/^event:\s*(.+)$/m)?.[1];
            const data = frame.match(/^data:\s*(.+)$/m)?.[1];
            if (eventName !== 'state_changed' || data === undefined) continue;
            publish(JSON.parse(data) as StateChangedEvent);
          }
        });
        incomingResponse.on('error', (error) => {
          if (!settled) reject(error);
        });

        settled = true;
        resolve({
          headers: incomingResponse.headers,
          received,
          waitForRevision(revision: number): Promise<StateChangedEvent> {
            const existing = received.find((event) => event.revision === revision);
            if (existing !== undefined) return Promise.resolve(existing);
            return new Promise((waitResolve) => {
              waiters.push({ revision, resolve: waitResolve });
            });
          },
          async close(): Promise<void> {
            request.destroy();
            response?.destroy();
            await new Promise<void>((waitResolve) => setImmediate(waitResolve));
          }
        });
      }
    );

    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

async function createTestServer(): Promise<TestServer> {
  const context = createTestContext({
    timestamp: TEST_TIMESTAMP,
    idGenerator: new DeterministicIdGenerator('http', 100)
  });
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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app: api.app,
    api,
    server,
    baseUrl,
    async close(): Promise<void> {
      api.events.close();
      // Node keeps the SSE connection alive by design; force-close any
      // remaining client connection before awaiting server.close().
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

function domainCollections(state: SharedStateProjectionWithCatalogs) {
  return {
    jobs: state.jobs,
    candidates: state.candidates,
    applications: state.applications,
    panels: state.panels,
    interviews: state.interviews,
    scorecards: state.scorecards,
    offers: state.offers,
    onboardingTasks: state.onboardingTasks,
    backgroundChecks: state.backgroundChecks,
    benefitsEnrollments: state.benefitsEnrollments
  };
}

function expectOutputKeys(body: unknown, keys: readonly string[]): void {
  expect(body).toBeTypeOf('object');
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(
    [...keys].sort()
  );
}

async function invokeCanonical(
  testServer: TestServer,
  events: SseConnection,
  name: OperationName,
  input: unknown,
  actor: ActorContext,
  expectedStatus = 200
): Promise<{
  result: HttpResult;
  state: SharedStateProjectionWithCatalogs;
}> {
  const previousRevision = testServer.api.repository.getRevision();
  const result = await jsonRequest(
    testServer.baseUrl,
    'POST',
    `/api/operations/${name}`,
    { input },
    {
      'x-actor-type': actor.actorType,
      'x-actor-id': actor.actorId
    }
  );
  expect(result.status).toBe(expectedStatus);
  expect(result.headers['content-type']).toContain('application/json');

  const event = await events.waitForRevision(previousRevision + 1);
  expect(event).toEqual({
    type: 'state_changed',
    revision: previousRevision + 1
  });

  const hydratedResult = await jsonRequest(testServer.baseUrl, 'GET', '/api/state');
  expect(hydratedResult.status).toBe(200);
  const state = hydratedResult.body as SharedStateProjectionWithCatalogs;
  expect(state.revision).toBe(previousRevision + 1);
  expect(state.activityLog).toHaveLength(previousRevision + 1);
  expect(state.activityLog.at(-1)).toMatchObject({
    id: expect.any(String),
    toolName: name,
    actorType: actor.actorType,
    actorId: actor.actorId,
    input: redactJsonObject(input),
    output: redactJsonObject(result.body),
    timestamp: TEST_TIMESTAMP
  });

  return { result, state };
}

// Feature: pipelineos, Task 8.4: Canonical HTTP/SSE/reset integration tests
// **Validates: Requirements 2.1, 2.6, 3.4, 3.5, 3.6, 24.2, 24.3, 24.4, 24.6, 25.1, 25.2**
describe('Task 8.4: canonical HTTP, SSE, reset, and hydration contracts', () => {
  it('exercises every canonical operation through real HTTP with human and agent contexts', async () => {
    const testServer = await createTestServer();
    const events = await openSse(testServer.baseUrl);
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('External network access is forbidden in canonical operation tests');
    });

    try {
      expect(events.headers['content-type']).toContain('text/event-stream');
      await expect(events.waitForRevision(0)).resolves.toEqual({
        type: 'state_changed',
        revision: 0
      });

      const invokedNames: OperationName[] = [];
      const invoke = async (
        name: OperationName,
        input: unknown,
        actor: ActorContext
      ) => {
        invokedNames.push(name);
        return invokeCanonical(testServer, events, name, input, actor);
      };

      const createJob = await invoke(
        'create_job_requisition',
        {
          title: 'Platform Reliability Engineer',
          department: 'Platform',
          requirements: ['TypeScript', 'Observability'],
          compBand: { min: 140000, max: 180000, currency: 'USD' }
        },
        actorFor(0)
      );
      expectOutputKeys(createJob.result.body, ['jobId']);
      expect(createJob.result.body).toEqual({ jobId: expect.stringMatching(/^job-/) });
      const createdJobId = (createJob.result.body as { jobId: string }).jobId;
      expect(createJob.state.jobs.find((job) => job.id === createdJobId)).toEqual({
        id: createdJobId,
        title: 'Platform Reliability Engineer',
        department: 'Platform',
        requirements: ['TypeScript', 'Observability'],
        compBand: { min: 140000, max: 180000, currency: 'USD' },
        status: 'open',
        createdBy: humanActor.actorId,
        createdAt: TEST_TIMESTAMP
      });

      const search = await invoke(
        'search_candidates',
        { query: 'AWS' },
        actorFor(1)
      );
      expect(search.result.body).toEqual({
        results: [
          {
            candidateId: 'cand-1',
            name: 'Ananya Sharma',
            matchScore: 20,
            rationale: 'Matched skills: aws; 8 years of experience.'
          },
          {
            candidateId: 'cand-2',
            name: 'Rohan Mehta',
            matchScore: 0,
            rationale: 'No queried skills matched; 3 years of experience.'
          },
          {
            candidateId: 'cand-3',
            name: 'Kavya Iyer',
            matchScore: 0,
            rationale: 'No queried skills matched; 5 years of experience.'
          }
        ]
      });

      const profile = await invoke(
        'get_candidate_profile',
        { candidateId: 'cand-1' },
        actorFor(2)
      );
      expect(profile.result.body).toEqual({
        id: 'cand-1',
        name: 'Ananya Sharma',
        email: 'ananya.sharma@example.com',
        resumeText: 'Experienced backend engineer with 8 years building scalable APIs.',
        skills: ['Node.js', 'TypeScript', 'AWS', 'Go'],
        experienceYears: 8,
        resumeTextHistory: [],
        applicationHistory: []
      });

      const applicationInput = {
        candidateId: 'cand-1',
        jobId: 'job-1',
        resumeText: 'Tailored backend resume submitted over canonical HTTP'
      };
      const application = await invoke(
        'submit_application',
        applicationInput,
        actorFor(3)
      );
      expectOutputKeys(application.result.body, ['applicationId', 'status']);
      const applicationOutput = application.result.body as {
        applicationId: string;
        status: string;
      };
      expect(applicationOutput).toEqual({
        applicationId: expect.stringMatching(/^application-/),
        status: 'applied'
      });
      expect(application.state.applications).toEqual([
        expect.objectContaining({
          id: applicationOutput.applicationId,
          candidateId: 'cand-1',
          jobId: 'job-1',
          status: 'applied',
          screeningScore: null,
          screeningRationale: null,
          notes: [],
          createdAt: TEST_TIMESTAMP
        })
      ]);
      expect(application.state.candidates[0].resumeTextHistory).toEqual([
        applicationInput.resumeText
      ]);

      const screen = await invoke(
        'screen_candidate',
        { applicationId: applicationOutput.applicationId },
        actorFor(4)
      );
      expect(screen.result.body).toEqual({
        applicationId: applicationOutput.applicationId,
        screeningScore: 65,
        screeningRationale:
          'Matched 2 of 4 requirements (50%); candidate has 8 years of experience (no explicit experience threshold was stated), for a weighted score of 65.',
        status: 'screened'
      });

      const faq = await invoke(
        'answer_candidate_faq',
        { jobId: 'job-1', question: 'What is the compensation range?' },
        actorFor(5)
      );
      expect(faq.result.body).toEqual({
        answer: 'The compensation band is 1800000–2600000 INR.',
        answeredFromData: true
      });

      const availability = await invoke(
        'check_interviewer_availability',
        {
          panelId: 'panel-1',
          dateRange: {
            start: '2026-09-01T00:00:00Z',
            end: '2026-09-04T00:00:00Z'
          }
        },
        actorFor(6)
      );
      expect(availability.result.body).toEqual({
        commonFreeSlots: [
          '2026-09-01T10:00:00Z',
          '2026-09-01T14:00:00Z',
          '2026-09-02T11:00:00Z',
          '2026-09-02T15:00:00Z',
          '2026-09-03T09:00:00Z'
        ]
      });

      const proposal = await invoke(
        'propose_interview_slots',
        { applicationId: applicationOutput.applicationId },
        actorFor(7)
      );
      expectOutputKeys(proposal.result.body, ['proposedSlots']);
      expect(proposal.result.body).toEqual({
        proposedSlots: [
          {
            interviewId: expect.stringMatching(/^interview-/),
            slot: '2026-09-01T10:00:00Z'
          },
          {
            interviewId: expect.stringMatching(/^interview-/),
            slot: '2026-09-01T14:00:00Z'
          },
          {
            interviewId: expect.stringMatching(/^interview-/),
            slot: '2026-09-02T11:00:00Z'
          }
        ]
      });
      const proposalOutput = proposal.result.body as {
        proposedSlots: Array<{ interviewId: string; slot: string }>;
      };
      expect(proposal.state.interviews).toEqual(
        proposalOutput.proposedSlots.map(({ interviewId, slot }) => ({
          id: interviewId,
          applicationId: applicationOutput.applicationId,
          panelId: 'panel-1',
          slot,
          status: 'proposed'
        }))
      );

      const booked = await invoke(
        'book_interview',
        {
          applicationId: applicationOutput.applicationId,
          slot: proposalOutput.proposedSlots[0].slot
        },
        actorFor(8)
      );
      expect(booked.result.body).toEqual({
        interviewId: proposalOutput.proposedSlots[0].interviewId,
        status: 'booked'
      });
      expect(booked.state.interviews).toEqual([
        expect.objectContaining({
          id: proposalOutput.proposedSlots[0].interviewId,
          status: 'booked'
        }),
        expect.objectContaining({ status: 'cancelled' }),
        expect.objectContaining({ status: 'cancelled' })
      ]);

      const kit = await invoke(
        'get_interview_kit',
        { jobId: 'job-1' },
        actorFor(9)
      );
      expectOutputKeys(kit.result.body, ['competencies']);
      const kitOutput = kit.result.body as {
        competencies: Array<{ name: string; questions: string[] }>;
      };
      expect(kitOutput.competencies).toHaveLength(4);
      expect(kitOutput.competencies.every((group) => group.questions.length > 0)).toBe(true);
      expect(kitOutput.competencies).toEqual(
        kit.state.catalogs.roleTemplates.find(
          (template) => template.id === 'template-engineering'
        )?.competencies
      );

      const competencyScores = Object.fromEntries(
        kitOutput.competencies.map((group) => [group.name, 5])
      );
      const feedback = await invoke(
        'submit_interview_feedback',
        {
          interviewId: proposalOutput.proposedSlots[0].interviewId,
          interviewer: 'http-human',
          competencyScores,
          recommendation: 'strong_yes',
          comments: 'Excellent systems reasoning and communication.'
        },
        actorFor(10)
      );
      expectOutputKeys(feedback.result.body, ['scorecardId']);
      expect(feedback.result.body).toEqual({
        scorecardId: expect.stringMatching(/^scorecard-/)
      });
      const scorecardId = (feedback.result.body as { scorecardId: string }).scorecardId;
      expect(feedback.state.scorecards).toEqual([
        {
          id: scorecardId,
          interviewId: proposalOutput.proposedSlots[0].interviewId,
          interviewer: 'http-human',
          competencyScores,
          recommendation: 'strong_yes',
          comments: 'Excellent systems reasoning and communication.',
          submittedAt: TEST_TIMESTAMP
        }
      ]);

      const summary = await invoke(
        'get_panel_feedback_summary',
        { applicationId: applicationOutput.applicationId },
        actorFor(11)
      );
      expect(summary.result.body).toEqual({
        averageScores: Object.fromEntries(
          kitOutput.competencies.map((group) => [group.name, 5])
        ),
        recommendationTally: { strong_yes: 1 },
        scorecards: feedback.state.scorecards
      });

      const offer = await invoke(
        'generate_offer',
        { applicationId: applicationOutput.applicationId, compAmount: 2200000 },
        actorFor(12)
      );
      expectOutputKeys(offer.result.body, ['offerId', 'status']);
      expect(offer.result.body).toEqual({
        offerId: expect.stringMatching(/^offer-/),
        status: 'draft'
      });
      const offerId = (offer.result.body as { offerId: string }).offerId;
      expect(offer.state.offers).toEqual([
        {
          id: offerId,
          applicationId: applicationOutput.applicationId,
          compAmount: 2200000,
          currency: 'INR',
          status: 'draft',
          counterAmount: null,
          sentAt: null,
          respondedAt: null
        }
      ]);

      const sent = await invoke(
        'send_offer',
        { offerId },
        actorFor(13)
      );
      expect(sent.result.body).toEqual({ offerId, status: 'sent' });
      expect(sent.state.offers[0]).toMatchObject({
        id: offerId,
        status: 'sent',
        sentAt: TEST_TIMESTAMP
      });
      expect(sent.state.applications[0].status).toBe('offer_sent');

      const response = await invoke(
        'respond_to_offer',
        { offerId, decision: 'accept' },
        actorFor(14)
      );
      expect(response.result.body).toEqual({ offerId, status: 'accepted' });
      expect(response.state.offers[0]).toMatchObject({
        id: offerId,
        status: 'accepted',
        respondedAt: TEST_TIMESTAMP
      });
      expect(response.state.applications[0].status).toBe('offer_accepted');

      const background = await invoke(
        'initiate_background_check',
        { offerId },
        actorFor(15)
      );
      expectOutputKeys(background.result.body, ['backgroundCheckId', 'status']);
      expect(background.result.body).toEqual({
        backgroundCheckId: expect.stringMatching(/^background-check-/),
        status: 'clear'
      });
      const backgroundCheckId = (background.result.body as { backgroundCheckId: string })
        .backgroundCheckId;
      expect(background.state.backgroundChecks).toEqual([
        {
          id: backgroundCheckId,
          offerId,
          status: 'clear',
          initiatedAt: TEST_TIMESTAMP,
          completedAt: TEST_TIMESTAMP
        }
      ]);

      const benefits = await invoke(
        'enroll_benefits',
        {
          offerId,
          planSelections: {
            medical: 'medical-plus',
            dental: 'dental-basic',
            vision: 'vision-plus'
          }
        },
        actorFor(16)
      );
      expectOutputKeys(benefits.result.body, ['enrollmentId']);
      expect(benefits.result.body).toEqual({
        enrollmentId: expect.stringMatching(/^benefits-/)
      });
      const enrollmentId = (benefits.result.body as { enrollmentId: string }).enrollmentId;
      expect(benefits.state.benefitsEnrollments).toEqual([
        {
          id: enrollmentId,
          offerId,
          planSelections: {
            medical: 'medical-plus',
            dental: 'dental-basic',
            vision: 'vision-plus'
          },
          enrolledAt: TEST_TIMESTAMP
        }
      ]);

      const checklist = await invoke(
        'generate_onboarding_checklist',
        { offerId },
        actorFor(17)
      );
      expectOutputKeys(checklist.result.body, ['tasks']);
      const checklistOutput = checklist.result.body as {
        tasks: Array<{ taskId: string; taskName: string; dueDate: string }>;
      };
      expect(checklistOutput.tasks).toEqual([
        {
          taskId: expect.stringMatching(/^onboarding-task-/),
          taskName: 'Provision engineering accounts',
          dueDate: '2026-09-07T09:00:00.000Z'
        },
        {
          taskId: expect.stringMatching(/^onboarding-task-/),
          taskName: 'Review security and deployment policies',
          dueDate: '2026-09-10T09:00:00.000Z'
        },
        {
          taskId: expect.stringMatching(/^onboarding-task-/),
          taskName: 'Join the platform onboarding session',
          dueDate: '2026-09-14T09:00:00.000Z'
        }
      ]);
      expect(checklist.state.onboardingTasks).toEqual(
        checklistOutput.tasks.map((task) => ({
          id: task.taskId,
          offerId,
          taskName: task.taskName,
          status: 'pending',
          dueDate: task.dueDate
        }))
      );
      expect(checklist.state.applications[0].status).toBe('onboarding');

      const onboarding = await invoke(
        'get_onboarding_status',
        { offerId },
        actorFor(18)
      );
      expect(onboarding.result.body).toEqual({
        backgroundCheckStatus: 'clear',
        benefitsEnrolled: true,
        taskCompletion: { done: 0, total: 3 },
        completionPercentage: 0
      });

      expect(invokedNames).toEqual(LEGACY_OPERATION_NAMES);
      expect(new Set(invokedNames.map((_name, index) => actorFor(index).actorType))).toEqual(
        new Set(['human_ui', 'agent'])
      );
      expect(externalFetch).not.toHaveBeenCalled();
      expect(events.received.slice(0, 20)).toEqual(
        Array.from({ length: 20 }, (_, revision) => ({
          type: 'state_changed',
          revision
        }))
      );
    } finally {
      externalFetch.mockRestore();
      await events.close();
      await testServer.close();
    }
  });

  it('returns exact structured errors, preserves domain state, and audits failures', async () => {
    const testServer = await createTestServer();
    const events = await openSse(testServer.baseUrl);

    try {
      await events.waitForRevision(0);
      const initialStateResult = await jsonRequest(testServer.baseUrl, 'GET', '/api/state');
      const initialState = initialStateResult.body as SharedStateProjectionWithCatalogs;

      const validation = await invokeCanonical(
        testServer,
        events,
        'search_candidates',
        { query: 42 },
        agentActor,
        400
      );
      expect(validation.result.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          status: 400,
          message: 'Invalid input for operation search_candidates',
          details: {
            field: 'input.query',
            issues: [
              {
                path: 'input.query',
                message: 'must be a string; received number',
                keyword: 'type'
              }
            ]
          }
        }
      });
      expect(domainCollections(validation.state)).toEqual(domainCollections(initialState));

      const notFound = await invokeCanonical(
        testServer,
        events,
        'get_candidate_profile',
        { candidateId: 'missing-candidate' },
        humanActor,
        404
      );
      expect(notFound.result.body).toEqual({
        error: {
          code: 'NOT_FOUND_ERROR',
          status: 404,
          message: 'Candidate not found',
          details: {
            recordType: 'Candidate_Record',
            recordId: 'missing-candidate'
          }
        }
      });
      expect(domainCollections(notFound.state)).toEqual(domainCollections(initialState));

      const applicationInput = {
        candidateId: 'cand-1',
        jobId: 'job-1',
        resumeText: 'A resume used for the conflict contract'
      };
      const firstApplication = await invokeCanonical(
        testServer,
        events,
        'submit_application',
        applicationInput,
        humanActor
      );
      const applicationId = (
        firstApplication.result.body as { applicationId: string }
      ).applicationId;
      const beforeConflict = firstApplication.state;

      const conflict = await invokeCanonical(
        testServer,
        events,
        'submit_application',
        applicationInput,
        agentActor,
        409
      );
      expect(conflict.result.body).toEqual({
        error: {
          code: 'CONFLICT_ERROR',
          status: 409,
          message: 'An application already exists for candidate cand-1 and job job-1',
          details: {
            recordType: 'Application_Record',
            recordId: applicationId,
            field: 'candidateId/jobId'
          }
        }
      });
      expect(domainCollections(conflict.state)).toEqual(domainCollections(beforeConflict));
      expect(conflict.state.activityLog.at(-1)).toMatchObject({
        toolName: 'submit_application',
        actorType: 'agent',
        actorId: agentActor.actorId,
        input: redactJsonObject(applicationInput),
        output: conflict.result.body
      });

      const unknownOperationRevision = testServer.api.repository.getRevision();
      const unknownOperation = await jsonRequest(
        testServer.baseUrl,
        'POST',
        '/api/operations/not_an_operation',
        { input: {} },
        {
          'x-actor-type': 'human_ui',
          'x-actor-id': humanActor.actorId
        }
      );
      expect(unknownOperation.status).toBe(400);
      expect(unknownOperation.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          status: 400,
          message: 'Unknown operation name',
          details: { field: 'operationName' }
        }
      });
      await expect(events.waitForRevision(unknownOperationRevision + 1)).resolves.toEqual({
        type: 'state_changed',
        revision: unknownOperationRevision + 1
      });
      const unknownStateResult = await jsonRequest(testServer.baseUrl, 'GET', '/api/state');
      const unknownState = unknownStateResult.body as SharedStateProjectionWithCatalogs;
      expect(domainCollections(unknownState)).toEqual(domainCollections(conflict.state));
      expect(unknownState.activityLog.at(-1)).toMatchObject({
        toolName: 'not_an_operation',
        actorType: humanActor.actorType,
        actorId: humanActor.actorId,
        input: {},
        output: unknownOperation.body
      });
      expect(unknownState.revision).toBe(unknownOperationRevision + 1);
    } finally {
      await events.close();
      await testServer.close();
    }
  });

  it('hydrates reset state as an isolated seed and keeps SSE revisions monotonic', async () => {
    const testServer = await createTestServer();
    const events = await openSse(testServer.baseUrl);

    try {
      await events.waitForRevision(0);
      const created = await invokeCanonical(
        testServer,
        events,
        'create_job_requisition',
        {
          title: 'Reset Isolation Engineer',
          department: 'Infrastructure',
          requirements: ['Testing'],
          compBand: { min: 100000, max: 130000, currency: 'USD' }
        },
        humanActor
      );
      const createdJobId = (created.result.body as { jobId: string }).jobId;
      expect(created.state.jobs.some((job) => job.id === createdJobId)).toBe(true);

      const firstResetRevision = testServer.api.repository.getRevision();
      const firstReset = await jsonRequest(testServer.baseUrl, 'POST', '/api/reset', {});
      expect(firstReset.status).toBe(200);
      expect(firstReset.body).toEqual({
        success: true,
        revision: firstResetRevision + 1
      });
      await expect(events.waitForRevision(firstResetRevision + 1)).resolves.toEqual({
        type: 'state_changed',
        revision: firstResetRevision + 1
      });

      const hydratedResetResult = await jsonRequest(testServer.baseUrl, 'GET', '/api/state');
      const hydratedReset = hydratedResetResult.body as SharedStateProjectionWithCatalogs;
      expect(hydratedReset.revision).toBe(firstResetRevision + 1);
      expect(hydratedReset.activityLog).toEqual([]);
      expect(hydratedReset.jobs).toEqual([
        expect.objectContaining({ id: 'job-1', title: 'Senior Backend Engineer' })
      ]);
      expect(hydratedReset.jobs.some((job) => job.id === createdJobId)).toBe(false);
      expect(hydratedReset.applications).toEqual([]);
      expect(hydratedReset.interviews).toEqual([]);
      expect(hydratedReset.offers).toEqual([]);
      expect(hydratedReset.onboardingTasks).toEqual([]);
      expect(hydratedReset.backgroundChecks).toEqual([]);
      expect(hydratedReset.benefitsEnrollments).toEqual([]);

      const afterResetCreateRevision = testServer.api.repository.getRevision();
      const afterResetCreate = await jsonRequest(
        testServer.baseUrl,
        'POST',
        '/api/operations/create_job_requisition',
        {
          input: {
            title: 'Post Reset Engineer',
            department: 'Infrastructure',
            requirements: ['Reliability'],
            compBand: { min: 110000, max: 140000, currency: 'USD' }
          }
        },
        {
          'x-actor-type': agentActor.actorType,
          'x-actor-id': agentActor.actorId
        }
      );
      expect(afterResetCreate.status).toBe(200);
      const afterResetEvent = await events.waitForRevision(afterResetCreateRevision + 1);
      expect(afterResetEvent).toEqual({
        type: 'state_changed',
        revision: afterResetCreateRevision + 1
      });
      const postResetStateResult = await jsonRequest(testServer.baseUrl, 'GET', '/api/state');
      const postResetState = postResetStateResult.body as SharedStateProjectionWithCatalogs;
      const postResetJobId = (afterResetCreate.body as { jobId: string }).jobId;
      expect(postResetState.jobs.some((job) => job.id === postResetJobId)).toBe(true);
      expect(postResetState.activityLog).toHaveLength(1);
      expect(postResetState.activityLog[0]).toMatchObject({
        toolName: 'create_job_requisition',
        actorType: 'agent',
        actorId: agentActor.actorId,
        output: afterResetCreate.body
      });

      const secondResetRevision = testServer.api.repository.getRevision();
      const secondReset = await jsonRequest(testServer.baseUrl, 'POST', '/api/reset', {});
      expect(secondReset.status).toBe(200);
      expect(secondReset.body).toEqual({
        success: true,
        revision: secondResetRevision + 1
      });
      await expect(events.waitForRevision(secondResetRevision + 1)).resolves.toEqual({
        type: 'state_changed',
        revision: secondResetRevision + 1
      });
      const finalStateResult = await jsonRequest(testServer.baseUrl, 'GET', '/api/state');
      const finalState = finalStateResult.body as SharedStateProjectionWithCatalogs;
      expect(finalState.revision).toBe(secondResetRevision + 1);
      expect(finalState.activityLog).toEqual([]);
      expect(finalState.jobs.some((job) => job.id === createdJobId)).toBe(false);
      expect(finalState.jobs.some((job) => job.id === postResetJobId)).toBe(false);
      expect(finalState.candidates.map((candidate) => candidate.id)).toEqual([
        'cand-1',
        'cand-2',
        'cand-3'
      ]);
      expect(finalState.catalogs).toEqual(hydratedReset.catalogs);
      expect(events.received.map((event) => event.revision)).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await events.close();
      await testServer.close();
    }
  });
});
