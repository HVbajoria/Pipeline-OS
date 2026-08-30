import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  ActorContext,
  ApplicationRecord,
  ApplicationStatus,
  CompensationBand,
  InterviewRecord,
  OfferRecord,
  OfferStatus,
  RoleTemplate,
  ScorecardRecommendation,
  SharedStateWithCatalogs,
  Timestamp
} from '../src/shared/models';
import type { OperationInputMap } from '../src/shared/operations';
import { OperationService } from '../src/server/operationService';
import { defaultOperationHandlers } from '../src/server/operations';
import { createSeed } from '../src/server/seed';
import {
  TEST_TIMESTAMP,
  assertAsyncProperty,
  createTestContext
} from './factories';

const nonBlankTextArbitrary = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((value) => value.trim().length > 0);
const currencyArbitrary = fc.constantFrom('USD', 'EUR', 'GBP');
const applicationIdArbitrary = fc
  .integer({ min: 0, max: 100_000 })
  .map((value) => `property-application-${value}`);
const offerIdArbitrary = fc
  .integer({ min: 0, max: 100_000 })
  .map((value) => `property-offer-${value}`);
const interviewIdArbitrary = fc
  .integer({ min: 0, max: 100_000 })
  .map((value) => `property-interview-${value}`);
const scoreArbitrary = fc.integer({ min: 1, max: 5 });
const slotPool: readonly Timestamp[] = [
  '2026-09-01T09:00:00Z',
  '2026-09-01T10:00:00Z',
  '2026-09-01T11:00:00Z',
  '2026-09-02T09:00:00Z',
  '2026-09-02T10:00:00Z',
  '2026-09-03T11:00:00Z'
];
const slotArbitrary = fc.constantFrom(...slotPool);
const applicationStatuses = [
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
] as const;
const offerStatuses = ['draft', 'sent', 'accepted', 'declined', 'countered'] as const;

interface CreateJobFixture {
  operation: 'create_job_requisition';
  input: OperationInputMap['create_job_requisition'];
}

interface SubmitApplicationFixture {
  operation: 'submit_application';
  input: OperationInputMap['submit_application'];
}

interface ScreenCandidateFixture {
  operation: 'screen_candidate';
  input: OperationInputMap['screen_candidate'];
}

interface ProposeInterviewSlotsFixture {
  operation: 'propose_interview_slots';
  input: OperationInputMap['propose_interview_slots'];
}

interface BookInterviewFixture {
  operation: 'book_interview';
  input: OperationInputMap['book_interview'];
  slots: Timestamp[];
}

interface SubmitInterviewFeedbackFixture {
  operation: 'submit_interview_feedback';
  input: OperationInputMap['submit_interview_feedback'];
  applicationId: string;
  interviewStatus: InterviewRecord['status'];
}

interface GenerateOfferFixture {
  operation: 'generate_offer';
  input: OperationInputMap['generate_offer'];
  applicationStatus: ApplicationStatus;
}

interface SendOfferFixture {
  operation: 'send_offer';
  input: OperationInputMap['send_offer'];
  applicationId: string;
}

interface RespondToOfferFixture {
  operation: 'respond_to_offer';
  input: OperationInputMap['respond_to_offer'];
  applicationId: string;
}

interface InitiateBackgroundCheckFixture {
  operation: 'initiate_background_check';
  input: OperationInputMap['initiate_background_check'];
  applicationId: string;
}

interface EnrollBenefitsFixture {
  operation: 'enroll_benefits';
  input: OperationInputMap['enroll_benefits'];
  applicationId: string;
  offerStatus: OfferStatus;
}

interface GenerateOnboardingChecklistFixture {
  operation: 'generate_onboarding_checklist';
  input: OperationInputMap['generate_onboarding_checklist'];
  applicationId: string;
  templateIndex: number;
}

type MutationFixture =
  | CreateJobFixture
  | SubmitApplicationFixture
  | ScreenCandidateFixture
  | ProposeInterviewSlotsFixture
  | BookInterviewFixture
  | SubmitInterviewFeedbackFixture
  | GenerateOfferFixture
  | SendOfferFixture
  | RespondToOfferFixture
  | InitiateBackgroundCheckFixture
  | EnrollBenefitsFixture
  | GenerateOnboardingChecklistFixture;

interface MutationFixtureSet {
  createJob: CreateJobFixture;
  submitApplication: SubmitApplicationFixture;
  screenCandidate: ScreenCandidateFixture;
  proposeInterviewSlots: ProposeInterviewSlotsFixture;
  bookInterview: BookInterviewFixture;
  submitInterviewFeedback: SubmitInterviewFeedbackFixture;
  generateOffer: GenerateOfferFixture;
  sendOffer: SendOfferFixture;
  respondToOffer: RespondToOfferFixture;
  initiateBackgroundCheck: InitiateBackgroundCheckFixture;
  enrollBenefits: EnrollBenefitsFixture;
  generateOnboardingChecklist: GenerateOnboardingChecklistFixture;
}

const compensationBandArbitrary: fc.Arbitrary<CompensationBand> = fc
  .record({
    minimum: fc.integer({ min: 0, max: 250_000 }),
    width: fc.integer({ min: 0, max: 50_000 }),
    currency: currencyArbitrary
  })
  .map(({ minimum, width, currency }) => ({
    min: minimum,
    max: minimum + width,
    currency
  }));

const createJobFixtureArbitrary: fc.Arbitrary<CreateJobFixture> = fc
  .record({
    title: nonBlankTextArbitrary,
    department: nonBlankTextArbitrary,
    requirements: fc.array(nonBlankTextArbitrary, {
      minLength: 1,
      maxLength: 5
    }),
    compBand: compensationBandArbitrary
  })
  .map((input) => ({
    operation: 'create_job_requisition' as const,
    input
  }));

const submitApplicationFixtureArbitrary: fc.Arbitrary<SubmitApplicationFixture> = fc
  .record({
    candidateId: fc.constantFrom('cand-1', 'cand-2', 'cand-3'),
    resumeText: nonBlankTextArbitrary
  })
  .map(({ candidateId, resumeText }) => ({
    operation: 'submit_application' as const,
    input: {
      candidateId,
      jobId: 'job-1',
      resumeText
    }
  }));

const screenCandidateFixtureArbitrary: fc.Arbitrary<ScreenCandidateFixture> =
  applicationIdArbitrary.map((applicationId) => ({
    operation: 'screen_candidate' as const,
    input: { applicationId }
  }));

const proposeInterviewSlotsFixtureArbitrary: fc.Arbitrary<ProposeInterviewSlotsFixture> =
  applicationIdArbitrary.map((applicationId) => ({
    operation: 'propose_interview_slots' as const,
    input: { applicationId }
  }));

const bookInterviewFixtureArbitrary: fc.Arbitrary<BookInterviewFixture> = fc
  .uniqueArray(slotArbitrary, {
    minLength: 1,
    maxLength: slotPool.length
  })
  .chain((slots) =>
    fc
      .record({
        applicationId: applicationIdArbitrary,
        selectedIndex: fc.integer({ min: 0, max: slots.length - 1 })
      })
      .map(({ applicationId, selectedIndex }) => ({
        operation: 'book_interview' as const,
        input: {
          applicationId,
          slot: slots[selectedIndex]!
        },
        slots
      }))
  );

const submitInterviewFeedbackFixtureArbitrary: fc.Arbitrary<SubmitInterviewFeedbackFixture> = fc
  .record({
    applicationId: applicationIdArbitrary,
    interviewId: interviewIdArbitrary,
    interviewStatus: fc.constantFrom<InterviewRecord['status']>('booked', 'completed'),
    interviewer: nonBlankTextArbitrary,
    competencyScores: fc.record({
      systemDesign: scoreArbitrary,
      coding: scoreArbitrary,
      collaboration: scoreArbitrary
    }),
    recommendation: fc.constantFrom<ScorecardRecommendation>(
      'strong_yes',
      'yes',
      'no',
      'strong_no'
    ),
    comments: nonBlankTextArbitrary
  })
  .map(
    ({
      applicationId,
      interviewId,
      interviewStatus,
      interviewer,
      competencyScores,
      recommendation,
      comments
    }) => ({
      operation: 'submit_interview_feedback' as const,
      input: {
        interviewId,
        interviewer,
        competencyScores,
        recommendation,
        comments
      },
      applicationId,
      interviewStatus
    })
  );

const generateOfferFixtureArbitrary: fc.Arbitrary<GenerateOfferFixture> = fc
  .record({
    applicationId: applicationIdArbitrary,
    applicationStatus: fc.constantFrom<ApplicationStatus>(...applicationStatuses),
    compAmount: fc.integer({ min: 0, max: 300_000 })
  })
  .map(({ applicationId, applicationStatus, compAmount }) => ({
    operation: 'generate_offer' as const,
    input: { applicationId, compAmount },
    applicationStatus
  }));

const sendOfferFixtureArbitrary: fc.Arbitrary<SendOfferFixture> = fc
  .record({
    applicationId: applicationIdArbitrary,
    offerId: offerIdArbitrary
  })
  .map(({ applicationId, offerId }) => ({
    operation: 'send_offer' as const,
    input: { offerId },
    applicationId
  }));

const respondToOfferFixtureArbitrary: fc.Arbitrary<RespondToOfferFixture> = fc
  .record({
    applicationId: applicationIdArbitrary,
    offerId: offerIdArbitrary,
    decision: fc.constantFrom('accept', 'decline', 'counter' as const),
    counterAmount: fc.integer({ min: 0, max: 300_000 })
  })
  .map(({ applicationId, offerId, decision, counterAmount }) => ({
    operation: 'respond_to_offer' as const,
    input:
      decision === 'counter'
        ? { offerId, decision, counterAmount }
        : { offerId, decision },
    applicationId
  }));

const initiateBackgroundCheckFixtureArbitrary: fc.Arbitrary<InitiateBackgroundCheckFixture> = fc
  .record({
    applicationId: applicationIdArbitrary,
    offerId: offerIdArbitrary
  })
  .map(({ applicationId, offerId }) => ({
    operation: 'initiate_background_check' as const,
    input: { offerId },
    applicationId
  }));

const enrollBenefitsFixtureArbitrary: fc.Arbitrary<EnrollBenefitsFixture> = fc
  .record({
    applicationId: applicationIdArbitrary,
    offerId: offerIdArbitrary,
    offerStatus: fc.constantFrom<OfferStatus>(...offerStatuses),
    planSelections: fc.record({
      medical: fc.constantFrom(...createSeed().catalogs.planCatalog.medical),
      dental: fc.constantFrom(...createSeed().catalogs.planCatalog.dental),
      vision: fc.constantFrom(...createSeed().catalogs.planCatalog.vision)
    })
  })
  .map(({ applicationId, offerId, offerStatus, planSelections }) => ({
    operation: 'enroll_benefits' as const,
    input: { offerId, planSelections },
    applicationId,
    offerStatus
  }));

const generateOnboardingChecklistFixtureArbitrary: fc.Arbitrary<GenerateOnboardingChecklistFixture> =
  fc
    .record({
      applicationId: applicationIdArbitrary,
      offerId: offerIdArbitrary,
      templateIndex: fc.integer({
        min: 0,
        max: createSeed().catalogs.roleTemplates.length - 1
      })
    })
    .map(({ applicationId, offerId, templateIndex }) => ({
      operation: 'generate_onboarding_checklist' as const,
      input: { offerId },
      applicationId,
      templateIndex
    }));

const mutationFixtureSetArbitrary: fc.Arbitrary<MutationFixtureSet> = fc.record({
  createJob: createJobFixtureArbitrary,
  submitApplication: submitApplicationFixtureArbitrary,
  screenCandidate: screenCandidateFixtureArbitrary,
  proposeInterviewSlots: proposeInterviewSlotsFixtureArbitrary,
  bookInterview: bookInterviewFixtureArbitrary,
  submitInterviewFeedback: submitInterviewFeedbackFixtureArbitrary,
  generateOffer: generateOfferFixtureArbitrary,
  sendOffer: sendOfferFixtureArbitrary,
  respondToOffer: respondToOfferFixtureArbitrary,
  initiateBackgroundCheck: initiateBackgroundCheckFixtureArbitrary,
  enrollBenefits: enrollBenefitsFixtureArbitrary,
  generateOnboardingChecklist: generateOnboardingChecklistFixtureArbitrary
});

function applicationFixture(
  id: string,
  status: ApplicationStatus,
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

function offerFixture(
  id: string,
  applicationId: string,
  status: OfferStatus
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

function seedForFixture(fixture: MutationFixture): ReturnType<typeof createSeed> {
  const seed = createSeed();

  switch (fixture.operation) {
    case 'create_job_requisition':
      return seed;
    case 'submit_application':
      return seed;
    case 'screen_candidate': {
      const { applicationId } = fixture.input;
      seed.applications.set(
        applicationId,
        applicationFixture(applicationId, 'applied')
      );
      return seed;
    }
    case 'propose_interview_slots': {
      const { applicationId } = fixture.input;
      seed.applications.set(
        applicationId,
        applicationFixture(applicationId, 'screened')
      );
      return seed;
    }
    case 'book_interview': {
      const { applicationId } = fixture.input;
      seed.applications.set(
        applicationId,
        applicationFixture(applicationId, 'screened')
      );
      seed.interviews = new Map(
        fixture.slots.map((slot, index) => {
          const interview: InterviewRecord = {
            id: `property-booking-interview-${index}`,
            applicationId,
            panelId: 'panel-1',
            slot,
            status: 'proposed'
          };
          return [interview.id, interview];
        })
      );
      return seed;
    }
    case 'submit_interview_feedback': {
      const { applicationId, interviewStatus } = fixture;
      const { interviewId } = fixture.input;
      seed.applications.set(
        applicationId,
        applicationFixture(applicationId, 'interviewing')
      );
      seed.interviews.set(interviewId, {
        id: interviewId,
        applicationId,
        panelId: 'panel-1',
        slot: '2026-09-01T10:00:00Z',
        status: interviewStatus
      });
      return seed;
    }
    case 'generate_offer': {
      const { applicationId } = fixture.input;
      seed.applications.set(
        applicationId,
        applicationFixture(applicationId, fixture.applicationStatus)
      );
      return seed;
    }
    case 'send_offer': {
      const { offerId } = fixture.input;
      seed.applications.set(
        fixture.applicationId,
        applicationFixture(fixture.applicationId, 'interviewing')
      );
      seed.offers.set(
        offerId,
        offerFixture(offerId, fixture.applicationId, 'draft')
      );
      return seed;
    }
    case 'respond_to_offer': {
      const { offerId } = fixture.input;
      seed.applications.set(
        fixture.applicationId,
        applicationFixture(fixture.applicationId, 'offer_sent')
      );
      seed.offers.set(
        offerId,
        offerFixture(offerId, fixture.applicationId, 'sent')
      );
      return seed;
    }
    case 'initiate_background_check': {
      const { offerId } = fixture.input;
      seed.applications.set(
        fixture.applicationId,
        applicationFixture(fixture.applicationId, 'offer_accepted')
      );
      seed.offers.set(
        offerId,
        offerFixture(offerId, fixture.applicationId, 'accepted')
      );
      return seed;
    }
    case 'enroll_benefits': {
      const { offerId } = fixture.input;
      seed.applications.set(
        fixture.applicationId,
        applicationFixture(fixture.applicationId, 'interviewing')
      );
      seed.offers.set(
        offerId,
        offerFixture(offerId, fixture.applicationId, fixture.offerStatus)
      );
      return seed;
    }
    case 'generate_onboarding_checklist': {
      const { offerId } = fixture.input;
      const template: RoleTemplate | undefined =
        seed.catalogs.roleTemplates[fixture.templateIndex];
      if (template === undefined) {
        throw new Error('Expected a seeded role template');
      }
      const jobId = 'property-onboarding-job';
      const baseJob = seed.jobs.get('job-1');
      if (baseJob === undefined) {
        throw new Error('Expected the seeded job');
      }
      const isGeneric = template.roleMatcher === 'generic';
      seed.jobs = new Map([
        [
          jobId,
          {
            ...baseJob,
            id: jobId,
            title: isGeneric ? 'Operations Coordinator' : `${template.roleMatcher} role`,
            department: isGeneric ? 'Operations' : template.roleMatcher,
            requirements: isGeneric ? ['Coordination'] : [template.roleMatcher]
          }
        ]
      ]);
      seed.applications.set(
        fixture.applicationId,
        applicationFixture(
          fixture.applicationId,
          'offer_accepted',
          'cand-1',
          jobId
        )
      );
      seed.offers.set(
        offerId,
        offerFixture(offerId, fixture.applicationId, 'accepted')
      );
      return seed;
    }
  }
}

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

async function invokeMutation(
  service: OperationService,
  fixture: MutationFixture,
  actor: ActorContext
): Promise<unknown> {
  switch (fixture.operation) {
    case 'create_job_requisition':
      return service.invoke('create_job_requisition', fixture.input, actor);
    case 'submit_application':
      return service.invoke('submit_application', fixture.input, actor);
    case 'screen_candidate':
      return service.invoke('screen_candidate', fixture.input, actor);
    case 'propose_interview_slots':
      return service.invoke('propose_interview_slots', fixture.input, actor);
    case 'book_interview':
      return service.invoke('book_interview', fixture.input, actor);
    case 'submit_interview_feedback':
      return service.invoke('submit_interview_feedback', fixture.input, actor);
    case 'generate_offer':
      return service.invoke('generate_offer', fixture.input, actor);
    case 'send_offer':
      return service.invoke('send_offer', fixture.input, actor);
    case 'respond_to_offer':
      return service.invoke('respond_to_offer', fixture.input, actor);
    case 'initiate_background_check':
      return service.invoke('initiate_background_check', fixture.input, actor);
    case 'enroll_benefits':
      return service.invoke('enroll_benefits', fixture.input, actor);
    case 'generate_onboarding_checklist':
      return service.invoke('generate_onboarding_checklist', fixture.input, actor);
  }
}

function assertOutputCorrespondence(
  fixture: MutationFixture,
  output: unknown,
  before: SharedStateWithCatalogs,
  committed: SharedStateWithCatalogs,
  actor: ActorContext
): void {
  switch (fixture.operation) {
    case 'create_job_requisition': {
      const typedOutput = output as { jobId: string };
      const { input } = fixture;
      expect(typedOutput).toEqual({ jobId: expect.any(String) });
      expect(committed.jobs.get(typedOutput.jobId)).toEqual({
        id: typedOutput.jobId,
        title: input.title,
        department: input.department,
        requirements: input.requirements,
        compBand: input.compBand,
        status: 'open',
        createdBy: actor.actorId,
        createdAt: TEST_TIMESTAMP
      });
      return;
    }
    case 'submit_application': {
      const typedOutput = output as { applicationId: string; status: 'applied' };
      const { input } = fixture;
      expect(typedOutput).toEqual({
        applicationId: expect.any(String),
        status: 'applied'
      });
      expect(committed.applications.get(typedOutput.applicationId)).toEqual({
        id: typedOutput.applicationId,
        candidateId: input.candidateId,
        jobId: input.jobId,
        status: 'applied',
        screeningScore: null,
        screeningRationale: null,
        notes: [],
        createdAt: TEST_TIMESTAMP
      });
      const beforeCandidate = before.candidates.get(input.candidateId);
      const committedCandidate = committed.candidates.get(input.candidateId);
      expect(beforeCandidate).toBeDefined();
      expect(committedCandidate).toBeDefined();
      const expectedHistory = [...beforeCandidate!.resumeTextHistory];
      if (
        input.resumeText !== beforeCandidate!.resumeText &&
        !expectedHistory.includes(input.resumeText)
      ) {
        expectedHistory.push(input.resumeText);
      }
      expect(committedCandidate).toEqual({
        ...beforeCandidate,
        resumeTextHistory: expectedHistory
      });
      return;
    }
    case 'screen_candidate': {
      const typedOutput = output as {
        applicationId: string;
        screeningScore: number;
        screeningRationale: string;
        status: 'screened';
      };
      const beforeApplication = before.applications.get(fixture.input.applicationId);
      expect(beforeApplication).toBeDefined();
      expect(typedOutput).toEqual({
        applicationId: fixture.input.applicationId,
        screeningScore: expect.any(Number),
        screeningRationale: expect.any(String),
        status: 'screened'
      });
      expect(committed.applications.get(typedOutput.applicationId)).toEqual({
        ...beforeApplication,
        status: 'screened',
        screeningScore: typedOutput.screeningScore,
        screeningRationale: typedOutput.screeningRationale
      });
      return;
    }
    case 'propose_interview_slots': {
      const typedOutput = output as {
        proposedSlots: Array<{ interviewId: string; slot: Timestamp }>;
      };
      const beforeApplication = before.applications.get(fixture.input.applicationId);
      const panel = [...before.panels.values()].find(
        (candidatePanel) => candidatePanel.jobId === beforeApplication?.jobId
      );
      expect(beforeApplication).toBeDefined();
      expect(panel).toBeDefined();
      expect(typedOutput.proposedSlots).toHaveLength(3);
      expect(committed.interviews.size).toBe(
        before.interviews.size + typedOutput.proposedSlots.length
      );
      const outputIds = new Set(
        typedOutput.proposedSlots.map(({ interviewId }) => interviewId)
      );
      expect(outputIds.size).toBe(typedOutput.proposedSlots.length);
      for (const proposed of typedOutput.proposedSlots) {
        expect(before.interviews.has(proposed.interviewId)).toBe(false);
        expect(committed.interviews.get(proposed.interviewId)).toEqual({
          id: proposed.interviewId,
          applicationId: fixture.input.applicationId,
          panelId: panel!.id,
          slot: proposed.slot,
          status: 'proposed'
        });
      }
      return;
    }
    case 'book_interview': {
      const typedOutput = output as { interviewId: string; status: 'booked' };
      const matchingInterview = [...before.interviews.values()].find(
        (interview) =>
          interview.applicationId === fixture.input.applicationId &&
          interview.status === 'proposed' &&
          interview.slot === fixture.input.slot
      );
      const beforeApplication = before.applications.get(fixture.input.applicationId);
      expect(matchingInterview).toBeDefined();
      expect(beforeApplication).toBeDefined();
      expect(typedOutput).toEqual({
        interviewId: matchingInterview!.id,
        status: 'booked'
      });
      expect(committed.interviews.get(typedOutput.interviewId)).toEqual({
        ...matchingInterview,
        status: 'booked'
      });
      for (const interview of before.interviews.values()) {
        const persisted = committed.interviews.get(interview.id);
        expect(persisted).toBeDefined();
        if (interview.id === matchingInterview!.id) {
          expect(persisted).toEqual({ ...interview, status: 'booked' });
        } else if (
          interview.applicationId === fixture.input.applicationId &&
          interview.status === 'proposed'
        ) {
          expect(persisted).toEqual({ ...interview, status: 'cancelled' });
        } else {
          expect(persisted).toEqual(interview);
        }
      }
      expect(committed.applications.get(fixture.input.applicationId)).toEqual({
        ...beforeApplication,
        status: 'interviewing'
      });
      return;
    }
    case 'submit_interview_feedback': {
      const typedOutput = output as { scorecardId: string };
      const { input } = fixture;
      const beforeInterview = before.interviews.get(input.interviewId);
      expect(beforeInterview).toBeDefined();
      expect(typedOutput).toEqual({ scorecardId: expect.any(String) });
      expect(committed.scorecards.get(typedOutput.scorecardId)).toEqual({
        id: typedOutput.scorecardId,
        interviewId: input.interviewId,
        interviewer: input.interviewer,
        competencyScores: input.competencyScores,
        recommendation: input.recommendation,
        comments: input.comments,
        submittedAt: TEST_TIMESTAMP
      });
      expect(committed.interviews.get(input.interviewId)).toEqual({
        ...beforeInterview,
        status: 'completed'
      });
      return;
    }
    case 'generate_offer': {
      const typedOutput = output as { offerId: string; status: 'draft' };
      const { input } = fixture;
      const application = before.applications.get(input.applicationId);
      const job = application === undefined ? undefined : before.jobs.get(application.jobId);
      expect(application).toBeDefined();
      expect(job).toBeDefined();
      expect(typedOutput).toEqual({
        offerId: expect.any(String),
        status: 'draft'
      });
      const outsideBand =
        input.compAmount < job!.compBand.min || input.compAmount > job!.compBand.max;
      const expectedOffer: OfferRecord = {
        id: typedOutput.offerId,
        applicationId: input.applicationId,
        compAmount: input.compAmount,
        currency: job!.compBand.currency,
        status: 'draft',
        counterAmount: null,
        sentAt: null,
        respondedAt: null,
        ...(outsideBand
          ? {
              compensationWarning: `Compensation amount ${input.compAmount} is outside the ${job!.compBand.currency} band of ${job!.compBand.min}-${job!.compBand.max}.`
            }
          : {})
      };
      expect(committed.offers.get(typedOutput.offerId)).toEqual(expectedOffer);
      return;
    }
    case 'send_offer': {
      const typedOutput = output as { offerId: string; status: 'sent' };
      const beforeOffer = before.offers.get(fixture.input.offerId);
      const beforeApplication = before.applications.get(fixture.applicationId);
      expect(beforeOffer).toBeDefined();
      expect(beforeApplication).toBeDefined();
      expect(typedOutput).toEqual({
        offerId: fixture.input.offerId,
        status: 'sent'
      });
      expect(committed.offers.get(fixture.input.offerId)).toEqual({
        ...beforeOffer,
        status: 'sent',
        sentAt: TEST_TIMESTAMP
      });
      expect(committed.applications.get(fixture.applicationId)).toEqual({
        ...beforeApplication,
        status: 'offer_sent'
      });
      return;
    }
    case 'respond_to_offer': {
      const typedOutput = output as {
        offerId: string;
        status: 'accepted' | 'declined' | 'countered';
      };
      const beforeOffer = before.offers.get(fixture.input.offerId);
      const beforeApplication = before.applications.get(fixture.applicationId);
      expect(beforeOffer).toBeDefined();
      expect(beforeApplication).toBeDefined();
      const expectedStatus =
        fixture.input.decision === 'accept'
          ? 'accepted'
          : fixture.input.decision === 'decline'
            ? 'declined'
            : 'countered';
      const expectedCounterAmount =
        fixture.input.decision === 'counter'
          ? fixture.input.counterAmount
          : null;
      expect(typedOutput).toEqual({
        offerId: fixture.input.offerId,
        status: expectedStatus
      });
      expect(committed.offers.get(fixture.input.offerId)).toEqual({
        ...beforeOffer,
        status: expectedStatus,
        counterAmount: expectedCounterAmount,
        respondedAt: TEST_TIMESTAMP
      });
      expect(committed.applications.get(fixture.applicationId)).toEqual(
        fixture.input.decision === 'counter'
          ? beforeApplication
          : {
              ...beforeApplication,
              status:
                fixture.input.decision === 'accept'
                  ? 'offer_accepted'
                  : 'offer_declined'
            }
      );
      return;
    }
    case 'initiate_background_check': {
      const typedOutput = output as {
        backgroundCheckId: string;
        status: 'clear';
      };
      expect(typedOutput).toEqual({
        backgroundCheckId: expect.any(String),
        status: 'clear'
      });
      expect(committed.backgroundChecks.get(typedOutput.backgroundCheckId)).toEqual({
        id: typedOutput.backgroundCheckId,
        offerId: fixture.input.offerId,
        status: 'clear',
        initiatedAt: TEST_TIMESTAMP,
        completedAt: TEST_TIMESTAMP
      });
      return;
    }
    case 'enroll_benefits': {
      const typedOutput = output as { enrollmentId: string };
      expect(typedOutput).toEqual({ enrollmentId: expect.any(String) });
      expect(committed.benefitsEnrollments.get(typedOutput.enrollmentId)).toEqual({
        id: typedOutput.enrollmentId,
        offerId: fixture.input.offerId,
        planSelections: fixture.input.planSelections,
        enrolledAt: TEST_TIMESTAMP
      });
      return;
    }
    case 'generate_onboarding_checklist': {
      const typedOutput = output as {
        tasks: Array<{ taskId: string; taskName: string; dueDate: Timestamp }>;
      };
      const beforeApplication = before.applications.get(fixture.applicationId);
      expect(beforeApplication).toBeDefined();
      expect(typedOutput.tasks.length).toBeGreaterThanOrEqual(2);
      expect(typedOutput.tasks.length).toBeLessThanOrEqual(3);
      expect(committed.onboardingTasks.size).toBe(
        before.onboardingTasks.size + typedOutput.tasks.length
      );
      const taskIds = new Set(typedOutput.tasks.map(({ taskId }) => taskId));
      expect(taskIds.size).toBe(typedOutput.tasks.length);
      for (const task of typedOutput.tasks) {
        expect(before.onboardingTasks.has(task.taskId)).toBe(false);
        expect(committed.onboardingTasks.get(task.taskId)).toEqual({
          id: task.taskId,
          offerId: fixture.input.offerId,
          taskName: task.taskName,
          status: 'pending',
          dueDate: task.dueDate
        });
      }
      expect(committed.applications.get(fixture.applicationId)).toEqual({
        ...beforeApplication,
        status: 'onboarding'
      });
      return;
    }
  }
}

async function assertMutationFixture(fixture: MutationFixture): Promise<void> {
  const { repository, actor } = createTestContext({
    seed: seedForFixture(fixture)
  });
  const service = new OperationService(repository, defaultOperationHandlers);
  const before = repository.read();
  const committedSnapshots: SharedStateWithCatalogs[] = [];
  let resolved = false;
  let commitsObservedBeforeResolution = 0;
  const unsubscribe = repository.subscribe((snapshot) => {
    committedSnapshots.push(snapshot);
    if (!resolved) commitsObservedBeforeResolution += 1;
  });

  try {
    const output = await invokeMutation(service, fixture, actor);
    resolved = true;

    expect(committedSnapshots).toHaveLength(1);
    expect(commitsObservedBeforeResolution).toBe(1);
    const [committed] = committedSnapshots;
    expect(committed).toBeDefined();
    expect(committed!.revision).toBe(before.revision + 1);
    expect(committed!.activityLog).toHaveLength(before.activityLog.length + 1);
    assertOutputCorrespondence(fixture, output, before, committed!, actor);
    expect(domainCollections(repository.read())).toEqual(
      domainCollections(committed!)
    );
  } finally {
    unsubscribe();
  }
}

describe('Property 1: atomic mutation output correspondence', () => {
  it('commits every generated mutation output before the operation resolves', async () => {
    // Feature: pipelineos, Property 1: Atomic mutation output correspondence
    // **Validates: Requirements 1.3, 4.1, 4.2, 7.1, 7.2, 8.3, 8.4, 11.3, 11.4, 14.2, 14.3, 14.4, 16.1, 16.3, 17.1, 17.2, 17.3, 18.1, 18.2, 18.3, 18.4, 19.1, 19.3, 20.2, 20.3, 21.3, 21.4, 21.5**
    await assertAsyncProperty(
      fc.asyncProperty(mutationFixtureSetArbitrary, async (fixtures) => {
        for (const fixture of Object.values(fixtures)) {
          await assertMutationFixture(fixture);
        }
      })
    );
  });
});
