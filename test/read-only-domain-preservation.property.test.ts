import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  ApplicationRecord,
  ApplicationStatus,
  BackgroundCheckStatus,
  CandidateRecord,
  DateRange,
  InterviewRecord,
  InterviewStatus,
  OfferRecord,
  OfferStatus,
  OnboardingTaskRecord,
  OnboardingTaskStatus,
  ScorecardRecord,
  ScorecardRecommendation,
  SharedStateWithCatalogs,
  Timestamp
} from '../src/shared/models';
import type {
  AnswerCandidateFaqInput,
  CheckInterviewerAvailabilityInput,
  GetCandidateProfileInput,
  GetInterviewKitInput,
  GetOnboardingStatusInput,
  GetPanelFeedbackSummaryInput,
  SearchCandidatesInput
} from '../src/shared/operations';
import { OperationService } from '../src/server/operationService';
import { defaultOperationHandlers } from '../src/server/operations';
import { createSeed } from '../src/server/seed';
import {
  PROPERTY_TEST_OPTIONS,
  TEST_TIMESTAMP,
  createActorContext,
  createTestContext
} from './factories';

const READ_PROFILE_APPLICATION_ID = 'read-profile-application';
const READ_SUMMARY_APPLICATION_ID = 'read-summary-application';
const READ_OFFER_ID = 'read-onboarding-offer';
const READ_PANEL_ID = 'panel-1';
const READ_JOB_ID = 'job-1';
const READ_CANDIDATE_ID = 'cand-1';

const skillArbitrary = fc.constantFrom(
  'AWS',
  'Backend',
  'CSS',
  'Django',
  'Express',
  'Go',
  'JavaScript',
  'Node.js',
  'PostgreSQL',
  'Python',
  'React',
  'SQL',
  'TypeScript'
);
const applicationStatusArbitrary = fc.constantFrom<ApplicationStatus>(
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
);
const interviewStatusArbitrary = fc.constantFrom<InterviewStatus>(
  'proposed',
  'booked',
  'completed',
  'cancelled'
);
const offerStatusArbitrary = fc.constantFrom<OfferStatus>(
  'draft',
  'sent',
  'accepted',
  'declined',
  'countered'
);
const taskStatusArbitrary = fc.constantFrom<OnboardingTaskStatus>(
  'pending',
  'in_progress',
  'complete'
);
const backgroundStatusArbitrary = fc.constantFrom<BackgroundCheckStatus>(
  'pending',
  'clear',
  'flagged'
);
const recommendationArbitrary = fc.constantFrom<ScorecardRecommendation>(
  'strong_yes',
  'yes',
  'no',
  'strong_no'
);
const timestampPool: readonly Timestamp[] = [
  '2026-09-01T09:00:00Z',
  '2026-09-01T10:00:00Z',
  '2026-09-01T11:00:00Z',
  '2026-09-02T09:00:00Z',
  '2026-09-02T10:00:00Z',
  '2026-09-03T11:00:00Z'
];
const taskDueDatePool: readonly Timestamp[] = [
  '2026-09-07T09:00:00Z',
  '2026-09-10T09:00:00Z',
  '2026-09-14T09:00:00Z',
  '2026-09-17T09:00:00Z',
  '2026-09-21T09:00:00Z'
];

const validDateRangeBoundaries: readonly Timestamp[] = [
  '2026-08-31T00:00:00Z',
  '2026-09-01T00:00:00Z',
  '2026-09-02T00:00:00Z',
  '2026-09-03T00:00:00Z',
  '2026-09-04T00:00:00Z',
  '2026-09-05T00:00:00Z'
];

const validDateRangeArbitrary: fc.Arbitrary<DateRange> = fc
  .integer({ min: 0, max: validDateRangeBoundaries.length - 2 })
  .chain((startIndex) =>
    fc
      .integer({
        min: startIndex + 1,
        max: validDateRangeBoundaries.length - 1
      })
      .map((endIndex) => ({
        start: validDateRangeBoundaries[startIndex],
        end: validDateRangeBoundaries[endIndex]
      }))
  );

const searchInputArbitrary: fc.Arbitrary<SearchCandidatesInput> = fc
  .record({
    queryTerms: fc.array(skillArbitrary, { maxLength: 5 }),
    skills: fc.array(skillArbitrary, { maxLength: 5 }),
    experienceLevel: fc.option(
      fc.constantFrom<SearchCandidatesInput['experienceLevel']>(
        'junior',
        'mid',
        'senior'
      ),
      { nil: undefined }
    )
  })
  .map(({ queryTerms, skills, experienceLevel }) => {
    const input: SearchCandidatesInput = {
      query: queryTerms.join(' '),
      skills
    };
    if (experienceLevel !== undefined) input.experienceLevel = experienceLevel;
    return input;
  });

const candidateFieldsArbitrary = fc.record({
  marker: fc.integer({ min: 0, max: 1_000_000 }),
  skills: fc.array(skillArbitrary, { maxLength: 6 }),
  experienceYears: fc.integer({ min: 0, max: 40 })
});

const extraJobFieldsArbitrary = fc.record({
  marker: fc.integer({ min: 0, max: 1_000_000 }),
  minimum: fc.integer({ min: 0, max: 250_000 }),
  rangeWidth: fc.integer({ min: 0, max: 50_000 }),
  currency: fc.constantFrom('USD', 'EUR', 'GBP')
});

interface ReadFixture {
  candidates: Array<{
    marker: number;
    skills: string[];
    experienceYears: number;
  }>;
  jobs: Array<{
    marker: number;
    minimum: number;
    rangeWidth: number;
    currency: string;
  }>;
  applicationStatuses: ApplicationStatus[];
  summaryApplicationStatus: ApplicationStatus;
  interviewStatuses: InterviewStatus[];
  scorecardScores: number[];
  recommendations: ScorecardRecommendation[];
  offerStatus: OfferStatus;
  offerAmount: number;
  taskStatuses: OnboardingTaskStatus[];
  backgroundStatus: BackgroundCheckStatus | undefined;
  benefitsEnrolled: boolean;
  searchInput: SearchCandidatesInput;
  faqQuestion: string;
  dateRange: DateRange;
}

const readFixtureArbitrary: fc.Arbitrary<ReadFixture> = fc.record({
  candidates: fc.array(candidateFieldsArbitrary, { maxLength: 5 }),
  jobs: fc.array(extraJobFieldsArbitrary, { maxLength: 4 }),
  applicationStatuses: fc.array(applicationStatusArbitrary, { maxLength: 6 }),
  summaryApplicationStatus: applicationStatusArbitrary,
  interviewStatuses: fc.array(interviewStatusArbitrary, { maxLength: 6 }),
  scorecardScores: fc.array(fc.integer({ min: 1, max: 5 }), {
    minLength: 1,
    maxLength: 6
  }),
  recommendations: fc.array(recommendationArbitrary, {
    minLength: 1,
    maxLength: 6
  }),
  offerStatus: offerStatusArbitrary,
  offerAmount: fc.integer({ min: 0, max: 300_000 }),
  taskStatuses: fc.array(taskStatusArbitrary, { maxLength: 5 }),
  backgroundStatus: fc.option(backgroundStatusArbitrary, { nil: undefined }),
  benefitsEnrolled: fc.boolean(),
  searchInput: searchInputArbitrary,
  faqQuestion: fc.integer({ min: 0, max: 1_000_000 }).map(
    (marker) => `What is the role title ${marker}?`
  ),
  dateRange: validDateRangeArbitrary
});

function candidateFromFields(
  fields: ReadFixture['candidates'][number],
  index: number
): CandidateRecord {
  return {
    id: `generated-candidate-${index}`,
    name: `Generated Candidate ${fields.marker}`,
    email: `generated-${fields.marker}@example.test`,
    resumeText: `Generated resume ${fields.marker}`,
    skills: fields.skills,
    experienceYears: fields.experienceYears,
    resumeTextHistory: []
  };
}

function applicationRecord(
  id: string,
  status: ApplicationStatus,
  candidateId = READ_CANDIDATE_ID
): ApplicationRecord {
  return {
    id,
    candidateId,
    jobId: READ_JOB_ID,
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

function buildReadSeed(fixture: ReadFixture): SharedStateWithCatalogs {
  const seed = createSeed();
  const generatedCandidates = fixture.candidates.map(candidateFromFields);
  seed.candidates = new Map([
    ...seed.candidates,
    ...generatedCandidates.map((candidate) => [candidate.id, candidate] as const)
  ]);

  const generatedJobs = fixture.jobs.map((fields, index) => ({
    id: `generated-job-${index}`,
    title: `Generated Role ${fields.marker}`,
    department: `Generated Department ${fields.marker}`,
    requirements: [`Generated Requirement ${fields.marker}`],
    compBand: {
      min: fields.minimum,
      max: fields.minimum + fields.rangeWidth,
      currency: fields.currency
    },
    status: 'open' as const,
    createdBy: 'generated-recruiter',
    createdAt: TEST_TIMESTAMP
  }));
  seed.jobs = new Map([
    ...seed.jobs,
    ...generatedJobs.map((job) => [job.id, job] as const)
  ]);

  const applications: ApplicationRecord[] = [
    applicationRecord(READ_PROFILE_APPLICATION_ID, 'applied'),
    applicationRecord(
      READ_SUMMARY_APPLICATION_ID,
      fixture.summaryApplicationStatus
    ),
    ...fixture.applicationStatuses.map((status, index) =>
      applicationRecord(`generated-application-${index}`, status)
    )
  ];
  seed.applications = new Map(
    applications.map((application) => [application.id, application])
  );

  const interviews: InterviewRecord[] = fixture.interviewStatuses.map(
    (status, index) => ({
      id: `read-interview-${index}`,
      applicationId: READ_SUMMARY_APPLICATION_ID,
      panelId: READ_PANEL_ID,
      slot: timestampPool[index % timestampPool.length],
      status
    })
  );
  seed.interviews = new Map(
    interviews.map((interview) => [interview.id, interview])
  );

  const scorecards: ScorecardRecord[] = interviews
    .map((interview, index) => {
      if (interview.status !== 'completed') return undefined;
      return {
        id: `read-scorecard-${index}`,
        interviewId: interview.id,
        interviewer: `interviewer-${(index % 3) + 1}`,
        competencyScores: {
          design: fixture.scorecardScores[index % fixture.scorecardScores.length]
        },
        recommendation:
          fixture.recommendations[index % fixture.recommendations.length],
        comments: `Generated feedback ${index}`,
        submittedAt: TEST_TIMESTAMP
      } satisfies ScorecardRecord;
    })
    .filter((scorecard) => scorecard !== undefined) as ScorecardRecord[];
  seed.scorecards = new Map(
    scorecards.map((scorecard) => [scorecard.id, scorecard])
  );

  const offer: OfferRecord = {
    id: READ_OFFER_ID,
    applicationId: READ_SUMMARY_APPLICATION_ID,
    compAmount: fixture.offerAmount,
    currency: 'USD',
    status: fixture.offerStatus,
    counterAmount: fixture.offerStatus === 'countered' ? fixture.offerAmount : null,
    sentAt: fixture.offerStatus === 'draft' ? null : TEST_TIMESTAMP,
    respondedAt:
      fixture.offerStatus === 'accepted' ||
      fixture.offerStatus === 'declined' ||
      fixture.offerStatus === 'countered'
        ? TEST_TIMESTAMP
        : null
  };
  seed.offers = new Map([[offer.id, offer]]);

  const onboardingTasks: OnboardingTaskRecord[] = fixture.taskStatuses.map(
    (status, index) => ({
      id: `read-task-${index}`,
      offerId: READ_OFFER_ID,
      taskName: `Generated onboarding task ${index}`,
      status,
      dueDate: taskDueDatePool[index % taskDueDatePool.length]
    })
  );
  seed.onboardingTasks = new Map(
    onboardingTasks.map((task) => [task.id, task])
  );

  if (fixture.backgroundStatus !== undefined) {
    const backgroundCheck = {
      id: 'read-background-check',
      offerId: READ_OFFER_ID,
      status: fixture.backgroundStatus,
      initiatedAt: TEST_TIMESTAMP,
      completedAt:
        fixture.backgroundStatus === 'pending' ? null : TEST_TIMESTAMP
    };
    seed.backgroundChecks = new Map([[backgroundCheck.id, backgroundCheck]]);
  }

  if (fixture.benefitsEnrolled) {
    const benefitsEnrollment = {
      id: 'read-benefits-enrollment',
      offerId: READ_OFFER_ID,
      planSelections: {
        medical: seed.catalogs.planCatalog.medical[0],
        dental: seed.catalogs.planCatalog.dental[0],
        vision: seed.catalogs.planCatalog.vision[0]
      },
      enrolledAt: TEST_TIMESTAMP
    };
    seed.benefitsEnrollments = new Map([
      [benefitsEnrollment.id, benefitsEnrollment]
    ]);
  }

  return seed;
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

type ReadInvocation =
  | { operation: 'search_candidates'; input: SearchCandidatesInput }
  | { operation: 'get_candidate_profile'; input: GetCandidateProfileInput }
  | { operation: 'answer_candidate_faq'; input: AnswerCandidateFaqInput }
  | {
      operation: 'check_interviewer_availability';
      input: CheckInterviewerAvailabilityInput;
    }
  | { operation: 'get_interview_kit'; input: GetInterviewKitInput }
  | {
      operation: 'get_panel_feedback_summary';
      input: GetPanelFeedbackSummaryInput;
    }
  | { operation: 'get_onboarding_status'; input: GetOnboardingStatusInput };

function readInvocations(fixture: ReadFixture): ReadInvocation[] {
  return [
    { operation: 'search_candidates', input: fixture.searchInput },
    {
      operation: 'get_candidate_profile',
      input: { candidateId: READ_CANDIDATE_ID }
    },
    {
      operation: 'answer_candidate_faq',
      input: { jobId: READ_JOB_ID, question: fixture.faqQuestion }
    },
    {
      operation: 'check_interviewer_availability',
      input: { panelId: READ_PANEL_ID, dateRange: fixture.dateRange }
    },
    { operation: 'get_interview_kit', input: { jobId: READ_JOB_ID } },
    {
      operation: 'get_panel_feedback_summary',
      input: { applicationId: READ_SUMMARY_APPLICATION_ID }
    },
    {
      operation: 'get_onboarding_status',
      input: { offerId: READ_OFFER_ID }
    }
  ];
}

async function invokeRead(
  service: OperationService,
  invocation: ReadInvocation,
  actor: ReturnType<typeof createActorContext>
): Promise<unknown> {
  switch (invocation.operation) {
    case 'search_candidates':
      return service.invoke('search_candidates', invocation.input, actor);
    case 'get_candidate_profile':
      return service.invoke('get_candidate_profile', invocation.input, actor);
    case 'answer_candidate_faq':
      return service.invoke('answer_candidate_faq', invocation.input, actor);
    case 'check_interviewer_availability':
      return service.invoke(
        'check_interviewer_availability',
        invocation.input,
        actor
      );
    case 'get_interview_kit':
      return service.invoke('get_interview_kit', invocation.input, actor);
    case 'get_panel_feedback_summary':
      return service.invoke(
        'get_panel_feedback_summary',
        invocation.input,
        actor
      );
    case 'get_onboarding_status':
      return service.invoke('get_onboarding_status', invocation.input, actor);
  }
}

describe('Property 2: read-only domain preservation', () => {
  it('preserves every domain collection for generated valid read states and inputs', async () => {
    // Feature: pipelineos, Property 2: Read-only domain preservation
    // **Validates: Requirements 1.4, 5.4, 6.2, 9.4, 10.3, 13.3, 15.5, 22.4**
    await fc.assert(
      fc.asyncProperty(readFixtureArbitrary, async (fixture) => {
        const seed = buildReadSeed(fixture);
        const actor = createActorContext({
          actorType: 'agent',
          actorId: 'property-read-agent'
        });

        for (const invocation of readInvocations(fixture)) {
          const { repository } = createTestContext({ seed, actor });
          const service = new OperationService(
            repository,
            defaultOperationHandlers
          );
          const before = repository.read();
          const output = await invokeRead(service, invocation, actor);
          const after = repository.read();

          expect(domainCollections(after)).toEqual(domainCollections(before));
          expect(after.catalogs).toEqual(before.catalogs);
          expect(after.revision).toBe(before.revision + 1);
          expect(after.activityLog).toHaveLength(before.activityLog.length + 1);
          expect(after.activityLog.slice(0, -1)).toEqual(before.activityLog);
          expect(after.activityLog.at(-1)).toMatchObject({
            toolName: invocation.operation,
            actorType: actor.actorType,
            actorId: actor.actorId,
            input: invocation.input,
            output,
            timestamp: TEST_TIMESTAMP
          });
        }
      }),
      PROPERTY_TEST_OPTIONS
    );
  });
});
