import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  ApplicationRecord,
  ApplicationStatus,
  InterviewRecord,
  OfferRecord,
  PlanSelections,
  SharedStateWithCatalogs
} from '../src/shared/models';
import {
  APPLICATION_TRANSITIONS,
  assertTransition,
  canTransition
} from '../src/shared/domain/lifecycle';
import {
  PipelineError,
  type PipelineErrorCode,
  type PipelineErrorStatus
} from '../src/shared/errors';
import type {
  OperationInputMap,
  OperationName
} from '../src/shared/operations';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { createSeed } from '../src/server/seed';
import {
  assertAsyncProperty,
  createTestContext,
  TEST_TIMESTAMP
} from './factories';

const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
];

const applicationStatusArbitrary = fc.constantFrom(...APPLICATION_STATUSES);
const nonBlankTextArbitrary = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((value) => value.trim().length > 0);
const invalidQueryArbitrary = fc.oneof(
  fc.integer(),
  fc.boolean(),
  fc.constant(null)
);

const rollbackDataArbitrary = fc.record({
  suffix: fc.integer({ min: 1, max: 1_000_000 }),
  resumeText: nonBlankTextArbitrary,
  invalidQuery: invalidQueryArbitrary
});

type FailureStatus = Extract<PipelineErrorStatus, 400 | 404 | 409>;

type Seed = ReturnType<typeof createSeed>;

interface FailureScenario {
  operation: OperationName;
  input: unknown;
  seed: Seed;
  expectedStatus: FailureStatus;
}

const ERROR_CODE_BY_STATUS: Readonly<Record<FailureStatus, PipelineErrorCode>> = {
  400: 'VALIDATION_ERROR',
  404: 'NOT_FOUND_ERROR',
  409: 'CONFLICT_ERROR'
};

function applicationFixture(
  id: string,
  status: ApplicationStatus,
  jobId = 'job-1'
): ApplicationRecord {
  return {
    id,
    candidateId: 'cand-1',
    jobId,
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
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
    compAmount: 175_000,
    currency: 'USD',
    status,
    counterAmount: null,
    sentAt: status === 'sent' ? TEST_TIMESTAMP : null,
    respondedAt: null
  };
}

function seedWithApplication(
  id: string,
  status: ApplicationStatus,
  jobId = 'job-1'
): Seed {
  const seed = createSeed();
  seed.applications = new Map([[id, applicationFixture(id, status, jobId)]]);
  return seed;
}

function seedWithOffer(
  suffix: number,
  applicationStatus: ApplicationStatus,
  offerStatus: OfferRecord['status']
): { seed: Seed; applicationId: string; offerId: string } {
  const seed = createSeed();
  const applicationId = `rollback-offer-application-${suffix}`;
  const offerId = `rollback-offer-${suffix}`;
  seed.applications = new Map([
    [applicationId, applicationFixture(applicationId, applicationStatus)]
  ]);
  seed.offers = new Map([
    [offerId, offerFixture(offerId, applicationId, offerStatus)]
  ]);
  return { seed, applicationId, offerId };
}

function validPlanSelections(): PlanSelections {
  const plans = createSeed().catalogs.planCatalog;
  return {
    medical: plans.medical[0]!,
    dental: plans.dental[0]!,
    vision: plans.vision[0]!
  };
}

/**
 * Keep the comparison focused on records that an operation is allowed to
 * mutate. Revision and activity-log changes are intentionally checked
 * separately because every rejected invocation still receives one audit row.
 */
function domainCollections(state: SharedStateWithCatalogs) {
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

function rollbackScenarios({
  suffix,
  resumeText,
  invalidQuery
}: {
  suffix: number;
  resumeText: string;
  invalidQuery: unknown;
}): FailureScenario[] {
  const missingCandidateId = `missing-candidate-${suffix}`;
  const missingApplicationId = `missing-application-${suffix}`;
  const missingJobId = `missing-job-${suffix}`;
  const missingPanelId = `missing-panel-${suffix}`;
  const missingInterviewId = `missing-interview-${suffix}`;
  const missingOfferId = `missing-offer-${suffix}`;
  const validPlans = validPlanSelections();
  const feedbackInput = {
    interviewId: missingInterviewId,
    interviewer: 'Property interviewer',
    competencyScores: { design: 3 },
    recommendation: 'yes' as const,
    comments: 'Property feedback'
  } satisfies OperationInputMap['submit_interview_feedback'];

  const duplicateApplicationSeed = createSeed();
  duplicateApplicationSeed.applications.set(
    `duplicate-application-${suffix}`,
    applicationFixture(`duplicate-application-${suffix}`, 'applied')
  );

  const closedJobSeed = createSeed();
  const openJob = closedJobSeed.jobs.get('job-1');
  if (openJob === undefined) throw new Error('Expected seeded job');
  closedJobSeed.jobs.set('job-1', { ...openJob, status: 'closed' });

  const screenedApplicationSeed = seedWithApplication(
    `screened-application-${suffix}`,
    'screened'
  );

  const noPanelSeed = createSeed();
  const noPanelJobId = `job-without-panel-${suffix}`;
  const noPanelBaseJob = noPanelSeed.jobs.get('job-1');
  if (noPanelBaseJob === undefined) throw new Error('Expected seeded job');
  noPanelSeed.jobs = new Map([
    [noPanelJobId, { ...noPanelBaseJob, id: noPanelJobId }]
  ]);
  noPanelSeed.panels = new Map();
  const noPanelApplicationId = `no-panel-application-${suffix}`;
  noPanelSeed.applications = new Map([
    [
      noPanelApplicationId,
      applicationFixture(noPanelApplicationId, 'screened', noPanelJobId)
    ]
  ]);

  const nonMatchingBookingSeed = seedWithApplication(
    `booking-application-${suffix}`,
    'screened'
  );
  const proposedInterview: InterviewRecord = {
    id: `proposed-interview-${suffix}`,
    applicationId: `booking-application-${suffix}`,
    panelId: 'panel-1',
    slot: '2026-09-01T10:00:00Z',
    status: 'proposed'
  };
  nonMatchingBookingSeed.interviews = new Map([
    [proposedInterview.id, proposedInterview]
  ]);

  const wrongFeedbackStatusSeed = seedWithApplication(
    `feedback-application-${suffix}`,
    'interviewing'
  );
  const wrongFeedbackInterviewId = `proposed-feedback-interview-${suffix}`;
  wrongFeedbackStatusSeed.interviews = new Map([
    [
      wrongFeedbackInterviewId,
      {
        id: wrongFeedbackInterviewId,
        applicationId: `feedback-application-${suffix}`,
        panelId: 'panel-1',
        slot: '2026-09-01T10:00:00Z',
        status: 'proposed'
      }
    ]
  ]);

  const duplicateBenefits = seedWithOffer(
    suffix,
    'interviewing',
    'draft'
  );
  duplicateBenefits.seed.benefitsEnrollments.set(
    `existing-benefits-${suffix}`,
    {
      id: `existing-benefits-${suffix}`,
      offerId: duplicateBenefits.offerId,
      planSelections: validPlans,
      enrolledAt: TEST_TIMESTAMP
    }
  );

  const duplicateChecklist = seedWithOffer(
    suffix,
    'offer_accepted',
    'accepted'
  );
  duplicateChecklist.seed.onboardingTasks.set(
    `existing-task-${suffix}`,
    {
      id: `existing-task-${suffix}`,
      offerId: duplicateChecklist.offerId,
      taskName: 'Existing task',
      status: 'pending',
      dueDate: TEST_TIMESTAMP
    }
  );

  const nonAcceptedBackground = seedWithOffer(
    suffix,
    'interviewing',
    'draft'
  );
  const nonAcceptedChecklist = seedWithOffer(
    suffix,
    'interviewing',
    'draft'
  );
  const sentOffer = seedWithOffer(suffix, 'offer_sent', 'sent');
  const nonSentOffer = seedWithOffer(suffix, 'offer_sent', 'draft');
  const invalidLifecycleOffer = seedWithOffer(
    suffix,
    'interviewing',
    'sent'
  );
  const sentOfferForCounter = seedWithOffer(suffix, 'offer_sent', 'sent');
  const sentOfferForSendConflict = seedWithOffer(
    suffix,
    'interviewing',
    'sent'
  );
  const draftOfferForApplicationConflict = seedWithOffer(
    suffix,
    'applied',
    'draft'
  );
  const invalidBenefits = seedWithOffer(suffix, 'interviewing', 'draft');

  return [
    {
      operation: 'create_job_requisition',
      input: {
        title: `Invalid role ${suffix}`,
        department: 'Engineering',
        requirements: [],
        compBand: { min: 100_000, max: 120_000, currency: 'USD' }
      },
      seed: createSeed(),
      expectedStatus: 400
    },
    {
      operation: 'search_candidates',
      input: { query: invalidQuery },
      seed: createSeed(),
      expectedStatus: 400
    },
    {
      operation: 'get_candidate_profile',
      input: { candidateId: missingCandidateId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'submit_application',
      input: { candidateId: missingCandidateId, jobId: 'job-1', resumeText },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'submit_application',
      input: { candidateId: 'cand-1', jobId: 'job-1', resumeText },
      seed: duplicateApplicationSeed,
      expectedStatus: 409
    },
    {
      operation: 'submit_application',
      input: { candidateId: 'cand-2', jobId: 'job-1', resumeText },
      seed: closedJobSeed,
      expectedStatus: 409
    },
    {
      operation: 'screen_candidate',
      input: { applicationId: missingApplicationId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'screen_candidate',
      input: {
        applicationId: `screened-application-${suffix}`
      },
      seed: screenedApplicationSeed,
      expectedStatus: 409
    },
    {
      operation: 'answer_candidate_faq',
      input: { jobId: missingJobId, question: 'What is the role?' },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'check_interviewer_availability',
      input: {
        panelId: missingPanelId,
        dateRange: {
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-02T00:00:00Z'
        }
      },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'check_interviewer_availability',
      input: {
        panelId: 'panel-1',
        dateRange: {
          start: '2026-09-02T00:00:00Z',
          end: '2026-09-02T00:00:00Z'
        }
      },
      seed: createSeed(),
      expectedStatus: 400
    },
    {
      operation: 'propose_interview_slots',
      input: { applicationId: missingApplicationId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'propose_interview_slots',
      input: { applicationId: noPanelApplicationId },
      seed: noPanelSeed,
      expectedStatus: 404
    },
    {
      operation: 'book_interview',
      input: {
        applicationId: missingApplicationId,
        slot: '2026-09-01T10:00:00Z'
      },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'book_interview',
      input: {
        applicationId: `booking-application-${suffix}`,
        slot: '2026-09-01T11:00:00Z'
      },
      seed: nonMatchingBookingSeed,
      expectedStatus: 409
    },
    {
      operation: 'get_interview_kit',
      input: { jobId: missingJobId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'submit_interview_feedback',
      input: feedbackInput,
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'submit_interview_feedback',
      input: {
        ...feedbackInput,
        interviewId: wrongFeedbackInterviewId
      },
      seed: wrongFeedbackStatusSeed,
      expectedStatus: 409
    },
    {
      operation: 'get_panel_feedback_summary',
      input: { applicationId: missingApplicationId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'generate_offer',
      input: { applicationId: missingApplicationId, compAmount: 175_000 },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'generate_offer',
      input: {
        applicationId: `screened-application-${suffix}`,
        compAmount: -1
      },
      seed: screenedApplicationSeed,
      expectedStatus: 400
    },
    {
      operation: 'send_offer',
      input: { offerId: missingOfferId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'send_offer',
      input: { offerId: sentOfferForSendConflict.offerId },
      seed: sentOfferForSendConflict.seed,
      expectedStatus: 409
    },
    {
      operation: 'send_offer',
      input: { offerId: draftOfferForApplicationConflict.offerId },
      seed: draftOfferForApplicationConflict.seed,
      expectedStatus: 409
    },
    {
      operation: 'respond_to_offer',
      input: { offerId: missingOfferId, decision: 'accept' },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'respond_to_offer',
      input: { offerId: nonSentOffer.offerId, decision: 'accept' },
      seed: nonSentOffer.seed,
      expectedStatus: 409
    },
    {
      operation: 'respond_to_offer',
      input: {
        offerId: sentOfferForCounter.offerId,
        decision: 'counter',
        counterAmount: -1
      },
      seed: sentOfferForCounter.seed,
      expectedStatus: 400
    },
    {
      operation: 'respond_to_offer',
      input: { offerId: invalidLifecycleOffer.offerId, decision: 'accept' },
      seed: invalidLifecycleOffer.seed,
      expectedStatus: 409
    },
    {
      operation: 'initiate_background_check',
      input: { offerId: missingOfferId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'initiate_background_check',
      input: { offerId: nonAcceptedBackground.offerId },
      seed: nonAcceptedBackground.seed,
      expectedStatus: 409
    },
    {
      operation: 'enroll_benefits',
      input: { offerId: missingOfferId, planSelections: validPlans },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'enroll_benefits',
      input: {
        offerId: invalidBenefits.offerId,
        planSelections: {
          ...validPlans,
          medical: `invalid-medical-${suffix}`
        }
      },
      seed: invalidBenefits.seed,
      expectedStatus: 400
    },
    {
      operation: 'enroll_benefits',
      input: {
        offerId: duplicateBenefits.offerId,
        planSelections: validPlans
      },
      seed: duplicateBenefits.seed,
      expectedStatus: 409
    },
    {
      operation: 'generate_onboarding_checklist',
      input: { offerId: missingOfferId },
      seed: createSeed(),
      expectedStatus: 404
    },
    {
      operation: 'generate_onboarding_checklist',
      input: { offerId: nonAcceptedChecklist.offerId },
      seed: nonAcceptedChecklist.seed,
      expectedStatus: 409
    },
    {
      operation: 'generate_onboarding_checklist',
      input: { offerId: duplicateChecklist.offerId },
      seed: duplicateChecklist.seed,
      expectedStatus: 409
    },
    {
      operation: 'get_onboarding_status',
      input: { offerId: missingOfferId },
      seed: createSeed(),
      expectedStatus: 404
    }
  ];
}

async function assertRejectedWithoutDomainMutation(
  scenario: FailureScenario
): Promise<void> {
  const { repository, actor } = createTestContext({ seed: scenario.seed });
  const service = new OperationService(repository, defaultOperationHandlers);
  const before = repository.read();

  let thrown: PipelineError | undefined;
  try {
    await service.invoke(
      scenario.operation,
      scenario.input as never,
      actor
    );
  } catch (error) {
    thrown = PipelineError.from(error);
  }

  if (thrown === undefined) {
    throw new Error(
      `Expected ${scenario.operation} to reject for generated rollback case`
    );
  }

  expect(thrown.status).toBe(scenario.expectedStatus);
  expect(thrown.code).toBe(ERROR_CODE_BY_STATUS[scenario.expectedStatus]);
  expect(thrown.toPayload()).toMatchObject({
    error: {
      code: ERROR_CODE_BY_STATUS[scenario.expectedStatus],
      status: scenario.expectedStatus,
      message: expect.any(String)
    }
  });

  const after = repository.read();
  expect(domainCollections(after)).toEqual(domainCollections(before));
  expect(after.catalogs).toEqual(before.catalogs);
  expect(after.activityLog).toHaveLength(1);
  expect(after.revision).toBe(1);
  expect(after.activityLog[0]).toMatchObject({
    toolName: scenario.operation,
    actorType: actor.actorType,
    actorId: actor.actorId,
    input: scenario.input,
    output: thrown.toPayload(),
    timestamp: TEST_TIMESTAMP
  });
}

describe('Property 20: lifecycle and rollback safety', () => {
  it('permits exactly the declared lifecycle edges for every generated status pair', async () => {
    // Feature: pipelineos, Property 20: Lifecycle and rollback safety
    // **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.6**
    await assertAsyncProperty(
      fc.asyncProperty(
        applicationStatusArbitrary,
        applicationStatusArbitrary,
        async (from, to) => {
          const expected = APPLICATION_TRANSITIONS[from].includes(to);
          const context = { actorRole: 'recruiter' as const };

          expect(canTransition(from, to, context)).toBe(expected);

          let thrown: PipelineError | undefined;
          try {
            assertTransition(from, to, context);
          } catch (error) {
            thrown = PipelineError.from(error);
          }

          if (expected) {
            expect(thrown).toBeUndefined();
            return;
          }

          if (thrown === undefined) {
            throw new Error(
              `Expected lifecycle transition ${from} -> ${to} to be rejected`
            );
          }
          expect(thrown.code).toBe('CONFLICT_ERROR');
          expect(thrown.status).toBe(409);
        }
      )
    );
  });

  it('preserves every domain record for generated invalid references, duplicates, and precondition failures', async () => {
    // Feature: pipelineos, Property 20: Lifecycle and rollback safety
    // **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.6, 24.1, 24.2, 24.3, 24.4, 24.5**
    await assertAsyncProperty(
      fc.asyncProperty(rollbackDataArbitrary, async (data) => {
        for (const scenario of rollbackScenarios(data)) {
          await assertRejectedWithoutDomainMutation(scenario);
        }
      })
    );
  });
});
