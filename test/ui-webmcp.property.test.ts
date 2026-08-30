import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { PipelineError, type PipelineErrorPayload } from '../src/shared/errors';
import type {
  ActorContext,
  ApplicationRecord,
  InterviewRecord,
  OfferRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import {
  OPERATION_NAMES,
  type OperationInputMap,
  type OperationName
} from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { createSeed } from '../src/server/seed';
import {
  assertAsyncProperty,
  createTestContext,
  DeterministicIdGenerator,
  FixedClock,
  TEST_TIMESTAMP
} from './factories';
import {
  registerAllTools,
  resetWebMcpRegistry,
  WebMcpRuntimeAdapter,
  type WebMcpRegisteredTool
} from '../src/lib/webmcp';

type OperationFixture = {
  [N in OperationName]: {
    name: N;
    input: OperationInputMap[N];
  };
}[OperationName];

type InvocationOutcome =
  | { kind: 'success'; output: unknown }
  | { kind: 'error'; error: PipelineErrorPayload };

const nonBlankTextArbitrary = fc
  .string({ minLength: 1, maxLength: 48 })
  .filter((value) => value.trim().length > 0);

const safeTokenArbitrary = fc
  .array(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')
    ),
    { minLength: 1, maxLength: 16 }
  )
  .map((characters) => characters.join(''));

const actorArbitrary: fc.Arbitrary<ActorContext> = fc.record({
  actorType: fc.constantFrom('human_ui' as const, 'agent' as const),
  actorId: safeTokenArbitrary
});

function referenceIdArbitrary(...validIds: readonly string[]): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom(...validIds),
    safeTokenArbitrary.map((token) => `missing-${token}`),
    fc.constant('')
  );
}

const questionArbitrary = fc.oneof(
  nonBlankTextArbitrary,
  fc.constant('')
);

const dateRangeArbitrary = fc.constantFrom(
  { start: '2026-09-01T00:00:00Z', end: '2026-09-04T00:00:00Z' },
  { start: '2026-09-02T00:00:00Z', end: '2026-09-03T00:00:00Z' },
  { start: '2026-09-02T00:00:00Z', end: '2026-09-02T00:00:00Z' },
  { start: '2026-09-03T00:00:00Z', end: '2026-09-01T00:00:00Z' },
  { start: 'not-a-timestamp', end: '2026-09-03T00:00:00Z' }
);

const competencyScoresArbitrary = fc
  .array(
    fc.record({
      competency: fc.constantFrom(
        'design',
        'coding',
        'reliability',
        'collaboration'
      ),
      score: fc.integer({ min: 0, max: 6 })
    }),
    { maxLength: 4 }
  )
  .map((entries) =>
    Object.fromEntries(
      entries.map(({ competency, score }) => [competency, score])
    )
  );

const planValueArbitrary = fc.oneof(
  fc.constantFrom(
    'medical-basic',
    'medical-plus',
    'medical-premium',
    'dental-basic',
    'dental-plus',
    'vision-basic',
    'vision-plus'
  ),
  safeTokenArbitrary.map((token) => `invalid-plan-${token}`)
);

const createJobInputArbitrary = fc.record({
  title: nonBlankTextArbitrary,
  department: nonBlankTextArbitrary,
  requirements: fc.array(nonBlankTextArbitrary, { maxLength: 4 }),
  compBand: fc.record({
    min: fc.integer({ min: 0, max: 250000 }),
    max: fc.integer({ min: 0, max: 250000 }),
    currency: nonBlankTextArbitrary
  })
});

const searchInputArbitrary = fc.oneof(
  fc.constant({}),
  fc.record({ query: fc.string({ maxLength: 48 }) }),
  fc.record({ skills: fc.array(nonBlankTextArbitrary, { maxLength: 4 }) }),
  fc.record({
    query: fc.string({ maxLength: 48 }),
    skills: fc.array(nonBlankTextArbitrary, { maxLength: 4 }),
    experienceLevel: fc.constantFrom('junior' as const, 'mid' as const, 'senior' as const)
  })
);

const submitApplicationInputArbitrary = fc.record({
  candidateId: referenceIdArbitrary('cand-3'),
  jobId: referenceIdArbitrary('job-1'),
  resumeText: fc.oneof(nonBlankTextArbitrary, fc.constant(''))
});

const offerAmountArbitrary = fc.integer({ min: -10000, max: 250000 });

const respondToOfferInputArbitrary = fc.oneof(
  fc.record({
    offerId: referenceIdArbitrary('offer-response', 'offer-send'),
    decision: fc.constantFrom('accept' as const, 'decline' as const)
  }),
  fc.record({
    offerId: referenceIdArbitrary('offer-response', 'offer-send'),
    decision: fc.constant('counter' as const),
    counterAmount: offerAmountArbitrary
  })
);

const planSelectionsArbitrary = fc.record({
  medical: planValueArbitrary,
  dental: planValueArbitrary,
  vision: planValueArbitrary
});

/**
 * Build one initial graph that gives every operation a valid reference while
 * leaving separate records for incompatible lifecycle preconditions. Each
 * adapter receives a deep clone of this graph for every generated case.
 */
function createEquivalenceSeed(): ReturnType<typeof createSeed> {
  const seed = createSeed();
  const applications: ApplicationRecord[] = [
    applicationFixture('application-screen', 'applied'),
    applicationFixture('application-propose', 'screened'),
    applicationFixture('application-book', 'screened'),
    applicationFixture('application-feedback', 'interviewing'),
    applicationFixture('application-summary', 'interviewing'),
    applicationFixture('application-generate', 'applied'),
    applicationFixture('application-send', 'interviewing'),
    applicationFixture('application-response', 'offer_sent'),
    applicationFixture('application-accepted', 'offer_accepted')
  ];

  seed.applications = new Map(
    applications.map((application) => [application.id, application])
  );
  seed.interviews = new Map<string, InterviewRecord>([
    [
      'interview-book-1',
      interviewFixture(
        'interview-book-1',
        'application-book',
        '2026-09-01T10:00:00Z',
        'proposed'
      )
    ],
    [
      'interview-book-2',
      interviewFixture(
        'interview-book-2',
        'application-book',
        '2026-09-01T14:00:00Z',
        'proposed'
      )
    ],
    [
      'interview-feedback',
      interviewFixture(
        'interview-feedback',
        'application-feedback',
        '2026-09-02T11:00:00Z',
        'booked'
      )
    ],
    [
      'interview-summary',
      interviewFixture(
        'interview-summary',
        'application-summary',
        '2026-09-02T15:00:00Z',
        'completed'
      )
    ]
  ]);
  seed.offers = new Map<string, OfferRecord>([
    ['offer-send', offerFixture('offer-send', 'draft', 'application-send')],
    ['offer-response', offerFixture('offer-response', 'sent', 'application-response')],
    [
      'offer-background',
      offerFixture('offer-background', 'accepted', 'application-accepted')
    ],
    [
      'offer-benefits',
      offerFixture('offer-benefits', 'accepted', 'application-accepted')
    ],
    [
      'offer-checklist',
      offerFixture('offer-checklist', 'accepted', 'application-accepted')
    ],
    [
      'offer-status',
      offerFixture('offer-status', 'accepted', 'application-accepted')
    ]
  ]);

  return seed;
}

function applicationFixture(
  id: string,
  status: ApplicationRecord['status']
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

function interviewFixture(
  id: string,
  applicationId: string,
  slot: string,
  status: InterviewRecord['status']
): InterviewRecord {
  return {
    id,
    applicationId,
    panelId: 'panel-1',
    slot,
    status
  };
}

function offerFixture(
  id: string,
  status: OfferRecord['status'],
  applicationId: string
): OfferRecord {
  return {
    id,
    applicationId,
    compAmount: 175000,
    currency: 'USD',
    status,
    counterAmount: null,
    sentAt: status === 'draft' ? null : TEST_TIMESTAMP,
    respondedAt: status === 'accepted' ? TEST_TIMESTAMP : null
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function serviceFetch(service: OperationService): FetchLike {
  return async (request, init) => {
    const url = String(request);
    if (url.endsWith('/api/state')) {
      return jsonResponse(serializeSharedState(service.repository.read()));
    }

    const operationName = url.split('/').at(-1) as OperationName;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown };
    const headers = new Headers(init?.headers);
    const actor: ActorContext = {
      actorType: headers.get('x-actor-type') as ActorContext['actorType'],
      actorId: headers.get('x-actor-id') ?? ''
    };

    try {
      const output = await service.invoke(
        operationName,
        body.input as never,
        actor
      );
      return jsonResponse(output);
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return jsonResponse(pipelineError.toPayload(), pipelineError.status);
    }
  };
}

function createService(seed: ReturnType<typeof createSeed>): OperationService {
  const context = createTestContext({
    seed,
    clock: new FixedClock(TEST_TIMESTAMP),
    idGenerator: new DeterministicIdGenerator('equivalence')
  });
  return new OperationService(context.repository, defaultOperationHandlers);
}

function domainSnapshot(state: SharedStateWithCatalogs) {
  return {
    jobs: [...state.jobs.values()],
    candidates: [...state.candidates.values()],
    applications: [...state.applications.values()],
    panels: [...state.panels.values()],
    interviews: [...state.interviews.values()],
    scorecards: [...state.scorecards.values()],
    offers: [...state.offers.values()],
    onboardingTasks: [...state.onboardingTasks.values()],
    backgroundChecks: [...state.backgroundChecks.values()],
    benefitsEnrollments: [...state.benefitsEnrollments.values()]
  };
}

async function captureOutcome(
  invoke: () => Promise<unknown>
): Promise<InvocationOutcome> {
  try {
    return { kind: 'success', output: await invoke() };
  } catch (error) {
    return {
      kind: 'error',
      error: PipelineError.from(error).toPayload()
    };
  }
}

const fixtureArbitrary: fc.Arbitrary<OperationFixture> = fc.oneof(
  fc.record({
    name: fc.constant('create_job_requisition' as const),
    input: createJobInputArbitrary
  }),
  fc.record({
    name: fc.constant('search_candidates' as const),
    input: searchInputArbitrary
  }),
  fc.record({
    name: fc.constant('get_candidate_profile' as const),
    input: fc.record({
      candidateId: referenceIdArbitrary('cand-1', 'cand-2', 'cand-3')
    })
  }),
  fc.record({
    name: fc.constant('submit_application' as const),
    input: submitApplicationInputArbitrary
  }),
  fc.record({
    name: fc.constant('screen_candidate' as const),
    input: fc.record({
      applicationId: referenceIdArbitrary('application-screen')
    })
  }),
  fc.record({
    name: fc.constant('answer_candidate_faq' as const),
    input: fc.record({
      jobId: referenceIdArbitrary('job-1'),
      question: questionArbitrary
    })
  }),
  fc.record({
    name: fc.constant('check_interviewer_availability' as const),
    input: fc.record({
      panelId: referenceIdArbitrary('panel-1'),
      dateRange: dateRangeArbitrary
    })
  }),
  fc.record({
    name: fc.constant('propose_interview_slots' as const),
    input: fc.record({
      applicationId: referenceIdArbitrary('application-propose')
    })
  }),
  fc.record({
    name: fc.constant('book_interview' as const),
    input: fc.record({
      applicationId: referenceIdArbitrary('application-book'),
      slot: fc.oneof(
        fc.constantFrom('2026-09-01T10:00:00Z', '2026-09-01T14:00:00Z'),
        fc.constant('2026-10-01T10:00:00Z'),
        fc.constant('not-a-timestamp')
      )
    })
  }),
  fc.record({
    name: fc.constant('get_interview_kit' as const),
    input: fc.record({ jobId: referenceIdArbitrary('job-1') })
  }),
  fc.record({
    name: fc.constant('submit_interview_feedback' as const),
    input: fc.record({
      interviewId: referenceIdArbitrary('interview-feedback', 'interview-book-1'),
      interviewer: fc.oneof(nonBlankTextArbitrary, fc.constant('')),
      competencyScores: competencyScoresArbitrary,
      recommendation: fc.constantFrom(
        'strong_yes' as const,
        'yes' as const,
        'no' as const,
        'strong_no' as const
      ),
      comments: fc.oneof(nonBlankTextArbitrary, fc.constant(''))
    })
  }),
  fc.record({
    name: fc.constant('get_panel_feedback_summary' as const),
    input: fc.record({
      applicationId: referenceIdArbitrary('application-summary', 'application-feedback')
    })
  }),
  fc.record({
    name: fc.constant('generate_offer' as const),
    input: fc.record({
      applicationId: referenceIdArbitrary('application-generate'),
      compAmount: offerAmountArbitrary
    })
  }),
  fc.record({
    name: fc.constant('send_offer' as const),
    input: fc.record({
      offerId: referenceIdArbitrary('offer-send', 'offer-response')
    })
  }),
  fc.record({
    name: fc.constant('respond_to_offer' as const),
    input: respondToOfferInputArbitrary
  }),
  fc.record({
    name: fc.constant('initiate_background_check' as const),
    input: fc.record({
      offerId: referenceIdArbitrary('offer-background', 'offer-send')
    })
  }),
  fc.record({
    name: fc.constant('enroll_benefits' as const),
    input: fc.record({
      offerId: referenceIdArbitrary('offer-benefits'),
      planSelections: planSelectionsArbitrary
    })
  }),
  fc.record({
    name: fc.constant('generate_onboarding_checklist' as const),
    input: fc.record({
      offerId: referenceIdArbitrary('offer-checklist', 'offer-send')
    })
  }),
  fc.record({
    name: fc.constant('get_onboarding_status' as const),
    input: fc.record({
      offerId: referenceIdArbitrary('offer-status', 'offer-background')
    })
  })
) as fc.Arbitrary<OperationFixture>;

class CapturingAdapter extends WebMcpRuntimeAdapter {
  readonly tools: WebMcpRegisteredTool[] = [];

  override register(tool: WebMcpRegisteredTool): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

// Feature: pipelineos, Property 4: UI/WebMCP operation equivalence
// **Validates: Requirements 2.2, 2.3, 2.4, 2.6, 24.6**
describe('Property 4: UI/WebMCP operation equivalence', () => {
  it('deep-compares every generated operation result and committed state across adapters', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        fixtureArbitrary,
        actorArbitrary,
        async (fixture, actor) => {
          resetWebMcpRegistry();
          try {
            const seed = createEquivalenceSeed();
            const uiService = createService(seed);
            const webService = createService(seed);
            const uiFetcher = serviceFetch(uiService);
            const webFetcher = serviceFetch(webService);
            const uiClient = new OperationClient({
              fetcher: uiFetcher,
              refreshState: async () => {
                await uiFetcher('/api/state');
              }
            });
            const webClient = new OperationClient({
              fetcher: webFetcher,
              refreshState: async () => {
                await webFetcher('/api/state');
              }
            });
            const adapter = new CapturingAdapter();
            registerAllTools({
              client: webClient,
              agentContext: actor,
              adapter,
              force: true
            });

            const tool = adapter.tools.find(
              (registeredTool) => registeredTool.name === fixture.name
            );
            if (tool === undefined) {
              throw new Error(`Missing WebMCP descriptor: ${fixture.name}`);
            }

            const uiOutcome = await captureOutcome(() =>
              uiClient.invoke(fixture.name, fixture.input as never, actor)
            );
            const webOutcome = await captureOutcome(() =>
              tool.execute(fixture.input)
            );

            expect(webOutcome).toEqual(uiOutcome);

            const uiState = uiService.repository.read();
            const webState = webService.repository.read();
            expect(domainSnapshot(webState)).toEqual(domainSnapshot(uiState));
            expect(webState.activityLog).toEqual(uiState.activityLog);
            expect(webState.revision).toBe(uiState.revision);
          } finally {
            resetWebMcpRegistry();
          }
        }
      )
    );
  });

  it('registers exactly the canonical 19-operation WebMCP registry', () => {
    resetWebMcpRegistry();
    const adapter = new CapturingAdapter();
    registerAllTools({ adapter, force: true });
    expect(adapter.tools.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
    resetWebMcpRegistry();
  });
});
