import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  OperationClient,
  type FetchLike
} from '../src/client/operationClient';
import { PipelineError } from '../src/shared/errors';
import { composeFaqAnswer } from '../src/shared/domain/faq';
import { aggregatePanelFeedback } from '../src/shared/domain/feedback';
import { calculateOnboardingStatus } from '../src/shared/domain/onboarding';
import type {
  ActorContext,
  ApplicationRecord,
  InterviewRecord,
  OfferRecord,
  PlanSelections,
  ScorecardRecommendation,
  SharedStateProjectionWithCatalogs
} from '../src/shared/models';
import type {
  CreateJobRequisitionInput,
  SubmitApplicationInput,
  SubmitInterviewFeedbackInput,
  OperationName
} from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { createTestContext, TEST_TIMESTAMP, assertAsyncProperty } from './factories';
import { createSeed } from '../src/server/seed';
import {
  registerAllTools,
  resetWebMcpRegistry,
  type WebMcpRegisteredTool
} from '../src/lib/webmcp';
import { useStore } from '../src/lib/store';

type JobFaqPair = {
  kind: 'job-faq';
  mutationInput: CreateJobRequisitionInput;
  question: string;
};

type SubmitProfilePair = {
  kind: 'submit-profile';
  mutationInput: SubmitApplicationInput;
};

type ScreenProfilePair = {
  kind: 'screen-profile';
};

type FeedbackSummaryPair = {
  kind: 'feedback-summary';
  feedbackInput: Omit<SubmitInterviewFeedbackInput, 'interviewId'>;
};

type BackgroundStatusPair = {
  kind: 'background-status';
};

type BenefitsStatusPair = {
  kind: 'benefits-status';
  planSelections: PlanSelections;
};

type ChecklistStatusPair = {
  kind: 'checklist-status';
};

type MutationReadPair =
  | JobFaqPair
  | SubmitProfilePair
  | ScreenProfilePair
  | FeedbackSummaryPair
  | BackgroundStatusPair
  | BenefitsStatusPair
  | ChecklistStatusPair;

const SCREEN_APPLICATION_ID = 'property-3-screen-application';
const FEEDBACK_APPLICATION_ID = 'property-3-feedback-application';
const FEEDBACK_INTERVIEW_ID = 'property-3-feedback-interview';
const BACKGROUND_OFFER_ID = 'property-3-background-offer';
const BENEFITS_OFFER_ID = 'property-3-benefits-offer';
const CHECKLIST_APPLICATION_ID = 'property-3-checklist-application';
const CHECKLIST_OFFER_ID = 'property-3-checklist-offer';

const nonBlankTextArbitrary = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((value) => value.trim().length > 0);

const actorTokenArbitrary = fc
  .array(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
    ),
    { minLength: 1, maxLength: 16 }
  )
  .map((characters) => characters.join(''));

const jobInputArbitrary: fc.Arbitrary<CreateJobRequisitionInput> = fc
  .record({
    title: nonBlankTextArbitrary,
    department: nonBlankTextArbitrary,
    requirements: fc.array(nonBlankTextArbitrary, {
      minLength: 1,
      maxLength: 4
    }),
    minimum: fc.integer({ min: 0, max: 200000 }),
    width: fc.integer({ min: 0, max: 50000 }),
    currency: fc.constantFrom('USD', 'EUR', 'GBP')
  })
  .map(({ title, department, requirements, minimum, width, currency }) => ({
    title,
    department,
    requirements,
    compBand: {
      min: minimum,
      max: minimum + width,
      currency
    }
  }));

const submitInputArbitrary: fc.Arbitrary<SubmitApplicationInput> = fc.record({
  candidateId: fc.constantFrom('cand-1', 'cand-2', 'cand-3'),
  jobId: fc.constant('job-1'),
  resumeText: nonBlankTextArbitrary
});

const competencyNames = [
  'design',
  'coding',
  'reliability',
  'collaboration'
] as const;

const competencyScoresArbitrary: fc.Arbitrary<Record<string, number>> = fc
  .uniqueArray(fc.constantFrom(...competencyNames), {
    minLength: 1,
    maxLength: competencyNames.length
  })
  .chain((names) =>
    fc
      .array(fc.integer({ min: 1, max: 5 }), {
        minLength: names.length,
        maxLength: names.length
      })
      .map((scores) =>
        Object.fromEntries(
          names.map((name, index) => [name, scores[index]])
        ) as Record<string, number>
      )
  );

const feedbackPairArbitrary: fc.Arbitrary<FeedbackSummaryPair> = fc
  .record({
    interviewer: nonBlankTextArbitrary,
    competencyScores: competencyScoresArbitrary,
    recommendation: fc.constantFrom<ScorecardRecommendation>(
      'strong_yes',
      'yes',
      'no',
      'strong_no'
    ),
    comments: nonBlankTextArbitrary
  })
  .map((feedbackInput) => ({
    kind: 'feedback-summary' as const,
    feedbackInput
  }));

const validPlanSelectionsArbitrary: fc.Arbitrary<PlanSelections> = fc.record({
  medical: fc.constantFrom('medical-basic', 'medical-plus', 'medical-premium'),
  dental: fc.constantFrom('dental-basic', 'dental-plus'),
  vision: fc.constantFrom('vision-basic', 'vision-plus')
});

const mutationReadPairArbitrary: fc.Arbitrary<MutationReadPair> = fc.oneof(
  jobInputArbitrary.chain((mutationInput) =>
    fc
      .constantFrom(
        'What is the role title, department, requirements, and compensation?',
        'What is the salary range for this position?',
        'Which skills and requirements are listed for the role?'
      )
      .map((question): JobFaqPair => ({
        kind: 'job-faq',
        mutationInput,
        question
      }))
  ),
  submitInputArbitrary.map((mutationInput): SubmitProfilePair => ({
    kind: 'submit-profile',
    mutationInput
  })),
  fc.constant<ScreenProfilePair>({ kind: 'screen-profile' }),
  feedbackPairArbitrary,
  fc.constant<BackgroundStatusPair>({ kind: 'background-status' }),
  validPlanSelectionsArbitrary.map((planSelections): BenefitsStatusPair => ({
    kind: 'benefits-status',
    planSelections
  })),
  fc.constant<ChecklistStatusPair>({ kind: 'checklist-status' })
);

function applicationFixture(
  id: string,
  status: ApplicationRecord['status'],
  candidateId = 'cand-1',
  jobId = 'job-1'
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

function interviewFixture(
  id: string,
  applicationId: string,
  status: InterviewRecord['status']
): InterviewRecord {
  return {
    id,
    applicationId,
    panelId: 'panel-1',
    slot: '2026-09-01T10:00:00Z',
    status
  };
}

function offerFixture(
  id: string,
  applicationId: string,
  status: OfferRecord['status']
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

function seedForPair(pair: MutationReadPair): ReturnType<typeof createSeed> {
  const seed = createSeed();

  switch (pair.kind) {
    case 'screen-profile':
      seed.applications = new Map([
        [
          SCREEN_APPLICATION_ID,
          applicationFixture(SCREEN_APPLICATION_ID, 'applied')
        ]
      ]);
      return seed;
    case 'feedback-summary':
      seed.applications = new Map([
        [
          FEEDBACK_APPLICATION_ID,
          applicationFixture(FEEDBACK_APPLICATION_ID, 'interviewing')
        ]
      ]);
      seed.interviews = new Map([
        [
          FEEDBACK_INTERVIEW_ID,
          interviewFixture(FEEDBACK_INTERVIEW_ID, FEEDBACK_APPLICATION_ID, 'booked')
        ]
      ]);
      return seed;
    case 'background-status':
      seed.applications = new Map([
        [
          'property-3-background-application',
          applicationFixture('property-3-background-application', 'offer_accepted')
        ]
      ]);
      seed.offers = new Map([
        [
          BACKGROUND_OFFER_ID,
          offerFixture(
            BACKGROUND_OFFER_ID,
            'property-3-background-application',
            'accepted'
          )
        ]
      ]);
      return seed;
    case 'benefits-status':
      seed.applications = new Map([
        [
          'property-3-benefits-application',
          applicationFixture('property-3-benefits-application', 'offer_sent')
        ]
      ]);
      seed.offers = new Map([
        [
          BENEFITS_OFFER_ID,
          offerFixture(
            BENEFITS_OFFER_ID,
            'property-3-benefits-application',
            'draft'
          )
        ]
      ]);
      return seed;
    case 'checklist-status':
      seed.applications = new Map([
        [
          CHECKLIST_APPLICATION_ID,
          applicationFixture(CHECKLIST_APPLICATION_ID, 'offer_accepted')
        ]
      ]);
      seed.offers = new Map([
        [
          CHECKLIST_OFFER_ID,
          offerFixture(
            CHECKLIST_OFFER_ID,
            CHECKLIST_APPLICATION_ID,
            'accepted'
          )
        ]
      ]);
      return seed;
    case 'job-faq':
    case 'submit-profile':
      return seed;
  }
}

function serviceFetch(service: OperationService): FetchLike {
  return async (request, init) => {
    const url = String(request);
    if (url.endsWith('/api/state')) {
      return new Response(JSON.stringify(serializeSharedState(service.repository.read())), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
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
      return new Response(JSON.stringify(output), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return new Response(JSON.stringify(pipelineError.toPayload()), {
        status: pipelineError.status,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
}

function toolFor(
  tools: readonly WebMcpRegisteredTool[],
  name: OperationName
): WebMcpRegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing WebMCP tool ${name}`);
  }
  return tool;
}

function mutationSpec(pair: MutationReadPair): {
  name: OperationName;
  input: unknown;
} {
  switch (pair.kind) {
    case 'job-faq':
      return {
        name: 'create_job_requisition',
        input: pair.mutationInput
      };
    case 'submit-profile':
      return {
        name: 'submit_application',
        input: pair.mutationInput
      };
    case 'screen-profile':
      return {
        name: 'screen_candidate',
        input: { applicationId: SCREEN_APPLICATION_ID }
      };
    case 'feedback-summary':
      return {
        name: 'submit_interview_feedback',
        input: {
          interviewId: FEEDBACK_INTERVIEW_ID,
          ...pair.feedbackInput
        }
      };
    case 'background-status':
      return {
        name: 'initiate_background_check',
        input: { offerId: BACKGROUND_OFFER_ID }
      };
    case 'benefits-status':
      return {
        name: 'enroll_benefits',
        input: {
          offerId: BENEFITS_OFFER_ID,
          planSelections: pair.planSelections
        }
      };
    case 'checklist-status':
      return {
        name: 'generate_onboarding_checklist',
        input: { offerId: CHECKLIST_OFFER_ID }
      };
  }
}

function readSpec(
  pair: MutationReadPair,
  mutationOutput: unknown
): { name: OperationName; input: unknown } {
  switch (pair.kind) {
    case 'job-faq':
      return {
        name: 'answer_candidate_faq',
        input: {
          jobId: (mutationOutput as { jobId: string }).jobId,
          question: pair.question
        }
      };
    case 'submit-profile':
      return {
        name: 'get_candidate_profile',
        input: { candidateId: pair.mutationInput.candidateId }
      };
    case 'screen-profile':
      return {
        name: 'get_candidate_profile',
        input: { candidateId: 'cand-1' }
      };
    case 'feedback-summary':
      return {
        name: 'get_panel_feedback_summary',
        input: { applicationId: FEEDBACK_APPLICATION_ID }
      };
    case 'background-status':
      return {
        name: 'get_onboarding_status',
        input: { offerId: BACKGROUND_OFFER_ID }
      };
    case 'benefits-status':
      return {
        name: 'get_onboarding_status',
        input: { offerId: BENEFITS_OFFER_ID }
      };
    case 'checklist-status':
      return {
        name: 'get_onboarding_status',
        input: { offerId: CHECKLIST_OFFER_ID }
      };
  }
}

function assertReadMatchesPersistedState(
  pair: MutationReadPair,
  mutationOutput: unknown,
  readOutput: unknown,
  state: ReturnType<ReturnType<typeof createTestContext>['repository']['read']>
): void {
  switch (pair.kind) {
    case 'job-faq': {
      const jobId = (mutationOutput as { jobId: string }).jobId;
      const job = state.jobs.get(jobId);
      if (job === undefined) throw new Error(`Missing persisted job ${jobId}`);
      expect(readOutput).toEqual(composeFaqAnswer(job, pair.question));
      return;
    }
    case 'submit-profile':
    case 'screen-profile': {
      const candidateId = pair.kind === 'submit-profile'
        ? pair.mutationInput.candidateId
        : 'cand-1';
      const candidate = state.candidates.get(candidateId);
      if (candidate === undefined) throw new Error(`Missing persisted candidate ${candidateId}`);
      const applicationHistory = [...state.applications.values()].filter(
        (application) => application.candidateId === candidateId
      );
      expect(readOutput).toEqual({ ...candidate, applicationHistory });
      return;
    }
    case 'feedback-summary':
      expect(readOutput).toEqual(
        aggregatePanelFeedback(
          FEEDBACK_APPLICATION_ID,
          state.interviews,
          state.scorecards
        )
      );
      return;
    case 'background-status':
    case 'benefits-status':
    case 'checklist-status': {
      const offerId = pair.kind === 'background-status'
        ? BACKGROUND_OFFER_ID
        : pair.kind === 'benefits-status'
          ? BENEFITS_OFFER_ID
          : CHECKLIST_OFFER_ID;
      expect(readOutput).toEqual(
        calculateOnboardingStatus({
          offerId,
          backgroundChecks: [...state.backgroundChecks.values()],
          benefitsEnrollments: [...state.benefitsEnrollments.values()],
          tasks: [...state.onboardingTasks.values()]
        })
      );
      return;
    }
  }
}

function projectionInStore(): SharedStateProjectionWithCatalogs {
  return useStore.getState().snapshot();
}

describe('Property 3: Mutation then read consistency', () => {
  it('returns persisted server values across UI and WebMCP boundaries', async () => {
    // Feature: pipelineos, Property 3: Mutation then read consistency
    // **Validates: Requirements 1.5, 23.5, 25.2**
    await assertAsyncProperty(
      fc.asyncProperty(
        mutationReadPairArbitrary,
        fc.boolean(),
        actorTokenArbitrary,
        async (pair, mutationThroughWebMcp, actorToken) => {
          resetWebMcpRegistry();
          try {
            const context = createTestContext({
              seed: seedForPair(pair),
              idPrefix: 'property-3'
            });
            const service = new OperationService(
              context.repository,
              defaultOperationHandlers
            );
            const fetcher = serviceFetch(service);
            const refreshState = async (): Promise<void> => {
              const response = await fetcher('/api/state');
              const projection = await response.json() as SharedStateProjectionWithCatalogs;
              useStore.getState().hydrate(projection);
            };
            const uiActor: ActorContext = {
              actorType: 'human_ui',
              actorId: `human-${actorToken}`
            };
            const agentActor: ActorContext = {
              actorType: 'agent',
              actorId: `agent-${actorToken}`
            };
            const uiClient = new OperationClient({
              fetcher,
              refreshState
            });
            const webClient = new OperationClient({
              fetcher,
              refreshState
            });
            const tools = registerAllTools({
              client: webClient,
              agentContext: agentActor,
              force: true
            });

            await refreshState();
            const staleProjection = projectionInStore();
            const mutation = mutationSpec(pair);
            const mutationOutput = mutationThroughWebMcp
              ? await toolFor(tools, mutation.name).execute(mutation.input)
              : await uiClient.invoke(
                  mutation.name,
                  mutation.input as never,
                  uiActor
                );

            // Simulate a client that has not yet observed the committed mutation.
            // The following read must come from the shared server operation path,
            // not from this intentionally rewound local/WebMCP state.
            useStore.getState().hydrate(staleProjection);
            const read = readSpec(pair, mutationOutput);
            const readOutput = mutationThroughWebMcp
              ? await uiClient.invoke(read.name, read.input as never, uiActor)
              : await toolFor(tools, read.name).execute(read.input);

            const persistedState = service.repository.read();
            assertReadMatchesPersistedState(
              pair,
              mutationOutput,
              readOutput,
              persistedState
            );
            expect(projectionInStore()).toEqual(
              serializeSharedState(persistedState)
            );
          } finally {
            resetWebMcpRegistry();
          }
        }
      )
    );
  });
});
