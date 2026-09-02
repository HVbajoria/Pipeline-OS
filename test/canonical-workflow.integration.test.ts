import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/shared/errors';
import {
  APPLICATION_TRANSITIONS,
  canTransition
} from '../src/shared/domain/lifecycle';
import type {
  ActorContext,
  ApplicationRecord,
  InterviewRecord,
  OfferRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import {
  type OperationInputMap,
  type OperationName,
  type OperationOutputMap
} from '../src/shared/operations';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { createSeed } from '../src/server/seed';
import { TEST_TIMESTAMP, createTestContext } from './factories';

/** The pre-agentic workflow list retained by this legacy regression scenario. */
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

/** Domain collections intentionally exclude revision and the audit stream. */
function domainSnapshot(state: SharedStateWithCatalogs) {
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

async function invokeAndAudit<N extends OperationName>(
  service: OperationService,
  name: N,
  input: OperationInputMap[N],
  actor: ActorContext
): Promise<OperationOutputMap[N]> {
  const before = service.repository.read();
  const output = await service.invoke(name, input, actor);
  const after = service.repository.read();
  const entry = after.activityLog.at(-1);

  expect(after.revision).toBe(before.revision + 1);
  expect(after.activityLog).toHaveLength(before.activityLog.length + 1);
  expect(entry).toMatchObject({
    toolName: name,
    actorType: actor.actorType,
    actorId: actor.actorId,
    input,
    output,
    timestamp: TEST_TIMESTAMP
  });

  return output;
}

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected the operation to reject');
}

function applicationFixture(
  id = 'regression-application',
  status: ApplicationRecord['status'] = 'applied'
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
  id = 'regression-interview',
  applicationId = 'regression-application',
  status: InterviewRecord['status'] = 'proposed'
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
  id = 'regression-offer',
  applicationId = 'regression-application',
  status: OfferRecord['status'] = 'draft'
): OfferRecord {
  return {
    id,
    applicationId,
    compAmount: 175000,
    currency: 'USD',
    status,
    counterAmount: null,
    sentAt: status === 'sent' ? TEST_TIMESTAMP : null,
    respondedAt: null
  };
}

function seedWithApplication(
  applicationStatus: ApplicationRecord['status'] = 'applied',
  options: {
    interviewStatus?: InterviewRecord['status'];
    offerStatus?: OfferRecord['status'];
  } = {}
) {
  const seed = createSeed();
  const application = applicationFixture('regression-application', applicationStatus);
  seed.applications = new Map([[application.id, application]]);

  if (options.interviewStatus !== undefined) {
    const interview = interviewFixture(
      'regression-interview',
      application.id,
      options.interviewStatus
    );
    seed.interviews = new Map([[interview.id, interview]]);
  }

  if (options.offerStatus !== undefined) {
    const offer = offerFixture(
      'regression-offer',
      application.id,
      options.offerStatus
    );
    seed.offers = new Map([[offer.id, offer]]);
  }

  return seed;
}

const recruiter: ActorContext = {
  actorType: 'human_ui',
  actorId: 'workflow-recruiter'
};
const candidate: ActorContext = {
  actorType: 'human_ui',
  actorId: 'alice-candidate'
};
const hiringManager: ActorContext = {
  actorType: 'human_ui',
  actorId: 'morgan-hiring-manager'
};
const agent: ActorContext = {
  actorType: 'agent',
  actorId: 'workflow-agent'
};

// Feature: pipelineos, Task 8.5: Full canonical workflow integration
// **Validates: Requirements 4.1–9.6, 10.1–15.7, 16.1–22.6, 23.1–24.7**
describe('Task 8.5: canonical server workflow and regression matrix', () => {
  it('drives all 20 operations through one deterministic workflow and asserts final onboarding status', async () => {
    // Keep the seeded panel attached to job-1 while creating that requisition
    // through the real operation, so every phase uses the same created role.
    const seed = createSeed();
    seed.jobs = new Map();
    const { repository } = createTestContext({ seed });
    const service = new OperationService(repository, defaultOperationHandlers);

    const createInput = {
      title: 'Senior Backend Engineer',
      department: 'Engineering',
      requirements: ['Node.js', 'Express', 'PostgreSQL', 'AWS'],
      compBand: { min: 160000, max: 190000, currency: 'USD' }
    };
    const created = await invokeAndAudit(
      service,
      'create_job_requisition',
      createInput,
      recruiter
    );
    expect(created).toEqual({ jobId: 'job-1' });
    expect(repository.read().jobs.get(created.jobId)).toEqual({
      id: created.jobId,
      ...createInput,
      status: 'open',
      createdBy: recruiter.actorId,
      createdAt: TEST_TIMESTAMP
    });

    const searchInput = {
      query: 'backend',
      skills: ['AWS'],
      experienceLevel: 'senior' as const
    };
    const beforeSearch = domainSnapshot(repository.read());
    const search = await invokeAndAudit(
      service,
      'search_candidates',
      searchInput,
      agent
    );
    expect(search.results.length).toBeLessThanOrEqual(10);
    expect(search.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: 'cand-1',
          name: 'Alice Chen',
          matchScore: expect.any(Number),
          rationale: expect.any(String)
        })
      ])
    );
    expect(search.results.every((result) => result.rationale.length > 0)).toBe(true);
    expect(domainSnapshot(repository.read())).toEqual(beforeSearch);

    const beforeInitialProfile = domainSnapshot(repository.read());
    const initialProfile = await invokeAndAudit(
      service,
      'get_candidate_profile',
      { candidateId: 'cand-1' },
      hiringManager
    );
    const seededCandidate = repository.read().candidates.get('cand-1');
    expect(seededCandidate).toBeDefined();
    expect(initialProfile).toEqual({
      ...seededCandidate,
      applicationHistory: []
    });
    expect(domainSnapshot(repository.read())).toEqual(beforeInitialProfile);

    const submitInput = {
      candidateId: 'cand-1',
      jobId: created.jobId,
      resumeText: 'Tailored backend resume for the Senior Backend Engineer role'
    };
    const submitted = await invokeAndAudit(
      service,
      'submit_application',
      submitInput,
      candidate
    );
    expect(submitted).toEqual({
      applicationId: expect.any(String),
      status: 'applied'
    });
    const applicationId = submitted.applicationId;
    expect(repository.read().applications.get(applicationId)).toEqual({
      id: applicationId,
      candidateId: submitInput.candidateId,
      jobId: submitInput.jobId,
      status: 'applied',
      screeningScore: null,
      screeningRationale: null,
      notes: [],
      createdAt: TEST_TIMESTAMP
    });
    expect(repository.read().candidates.get('cand-1')?.resumeTextHistory).toEqual([
      submitInput.resumeText
    ]);

    const afterSubmitProfile = await invokeAndAudit(
      service,
      'get_candidate_profile',
      { candidateId: 'cand-1' },
      recruiter
    );
    expect(afterSubmitProfile.applicationHistory).toEqual([
      repository.read().applications.get(applicationId)
    ]);

    const screened = await invokeAndAudit(
      service,
      'screen_candidate',
      { applicationId },
      recruiter
    );
    expect(screened).toEqual({
      applicationId,
      screeningScore: expect.any(Number),
      screeningRationale: expect.any(String),
      status: 'screened'
    });
    expect(screened.screeningScore).toBeGreaterThanOrEqual(0);
    expect(screened.screeningScore).toBeLessThanOrEqual(100);
    expect(screened.screeningRationale.length).toBeGreaterThan(0);
    expect(repository.read().applications.get(applicationId)).toMatchObject({
      status: 'screened',
      screeningScore: screened.screeningScore,
      screeningRationale: screened.screeningRationale
    });

    const faqInput = {
      jobId: created.jobId,
      question: 'What are the role title, department, requirements, and compensation range?'
    };
    const beforeFaq = domainSnapshot(repository.read());
    const faq = await invokeAndAudit(
      service,
      'answer_candidate_faq',
      faqInput,
      candidate
    );
    expect(faq).toEqual({
      answer: expect.any(String),
      answeredFromData: true
    });
    expect(faq.answer).toContain('Senior Backend Engineer');
    expect(faq.answer).toContain('160000');
    expect(domainSnapshot(repository.read())).toEqual(beforeFaq);

    const availabilityInput = {
      panelId: 'panel-1',
      dateRange: {
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-04T00:00:00Z'
      }
    };
    const beforeAvailability = domainSnapshot(repository.read());
    const availability = await invokeAndAudit(
      service,
      'check_interviewer_availability',
      availabilityInput,
      recruiter
    );
    expect(availability).toEqual({
      commonFreeSlots: [
        '2026-09-01T10:00:00Z',
        '2026-09-01T14:00:00Z',
        '2026-09-02T11:00:00Z',
        '2026-09-02T15:00:00Z',
        '2026-09-03T09:00:00Z'
      ]
    });
    expect(domainSnapshot(repository.read())).toEqual(beforeAvailability);

    const proposal = await invokeAndAudit(
      service,
      'propose_interview_slots',
      { applicationId },
      recruiter
    );
    expect(proposal.proposedSlots).toHaveLength(3);
    expect(proposal.proposedSlots.map(({ slot }) => slot)).toEqual(
      availability.commonFreeSlots.slice(0, 3)
    );
    expect(
      proposal.proposedSlots.every(({ interviewId, slot }) => {
        const interview = repository.read().interviews.get(interviewId);
        return (
          interview?.applicationId === applicationId &&
          interview.panelId === 'panel-1' &&
          interview.slot === slot &&
          interview.status === 'proposed'
        );
      })
    ).toBe(true);
    expect(repository.read().applications.get(applicationId)?.status).toBe('screened');

    const bookedInput = {
      applicationId,
      slot: proposal.proposedSlots[1].slot
    };
    const booked = await invokeAndAudit(
      service,
      'book_interview',
      bookedInput,
      candidate
    );
    expect(booked).toEqual({
      interviewId: proposal.proposedSlots[1].interviewId,
      status: 'booked'
    });
    const bookedInterviews = [...repository.read().interviews.values()].filter(
      (interview) => interview.applicationId === applicationId
    );
    expect(bookedInterviews.find((interview) => interview.id === booked.interviewId)?.status).toBe(
      'booked'
    );
    expect(
      bookedInterviews
        .filter((interview) => interview.id !== booked.interviewId)
        .every((interview) => interview.status === 'cancelled')
    ).toBe(true);
    expect(repository.read().applications.get(applicationId)?.status).toBe('interviewing');

    const beforeKit = domainSnapshot(repository.read());
    const kit = await invokeAndAudit(
      service,
      'get_interview_kit',
      { jobId: created.jobId },
      hiringManager
    );
    expect(kit.competencies.length).toBeGreaterThanOrEqual(3);
    expect(kit.competencies.length).toBeLessThanOrEqual(4);
    expect(kit.competencies.every((group) => group.name && group.questions.length > 0)).toBe(true);
    expect(domainSnapshot(repository.read())).toEqual(beforeKit);

    const feedbackInput = {
      interviewId: booked.interviewId,
      interviewer: hiringManager.actorId,
      competencyScores: Object.fromEntries(
        kit.competencies.map((competency) => [competency.name, 5])
      ),
      recommendation: 'strong_yes' as const,
      comments: 'Strong systems thinking and clear communication.'
    };
    const feedback = await invokeAndAudit(
      service,
      'submit_interview_feedback',
      feedbackInput,
      hiringManager
    );
    expect(feedback).toEqual({ scorecardId: expect.any(String) });
    expect(repository.read().scorecards.get(feedback.scorecardId)).toMatchObject({
      id: feedback.scorecardId,
      interviewId: booked.interviewId,
      interviewer: feedbackInput.interviewer,
      competencyScores: feedbackInput.competencyScores,
      recommendation: feedbackInput.recommendation,
      comments: feedbackInput.comments,
      submittedAt: TEST_TIMESTAMP
    });
    expect(repository.read().interviews.get(booked.interviewId)?.status).toBe('completed');

    const beforeSummary = domainSnapshot(repository.read());
    const summary = await invokeAndAudit(
      service,
      'get_panel_feedback_summary',
      { applicationId },
      recruiter
    );
    expect(summary.scorecards).toEqual([
      repository.read().scorecards.get(feedback.scorecardId)
    ]);
    expect(summary.recommendationTally).toEqual({ strong_yes: 1 });
    expect(Object.values(summary.averageScores)).toEqual(
      kit.competencies.map(() => 5)
    );
    expect(domainSnapshot(repository.read())).toEqual(beforeSummary);

    const generatedOffer = await invokeAndAudit(
      service,
      'generate_offer',
      { applicationId, compAmount: 175000 },
      recruiter
    );
    expect(generatedOffer).toEqual({
      offerId: expect.any(String),
      status: 'draft'
    });
    const offerId = generatedOffer.offerId;
    expect(repository.read().offers.get(offerId)).toEqual({
      id: offerId,
      applicationId,
      compAmount: 175000,
      currency: 'USD',
      status: 'draft',
      counterAmount: null,
      sentAt: null,
      respondedAt: null
    });

    const sentOffer = await invokeAndAudit(
      service,
      'send_offer',
      { offerId },
      recruiter
    );
    expect(sentOffer).toEqual({ offerId, status: 'sent' });
    expect(repository.read().offers.get(offerId)).toMatchObject({
      status: 'sent',
      sentAt: TEST_TIMESTAMP
    });
    expect(repository.read().applications.get(applicationId)?.status).toBe('offer_sent');

    const accepted = await invokeAndAudit(
      service,
      'respond_to_offer',
      { offerId, decision: 'accept' },
      candidate
    );
    expect(accepted).toEqual({ offerId, status: 'accepted' });
    expect(repository.read().offers.get(offerId)).toMatchObject({
      status: 'accepted',
      respondedAt: TEST_TIMESTAMP,
      counterAmount: null
    });
    expect(repository.read().applications.get(applicationId)?.status).toBe('offer_accepted');

    const background = await invokeAndAudit(
      service,
      'initiate_background_check',
      { offerId },
      agent
    );
    expect(background).toEqual({
      backgroundCheckId: expect.any(String),
      status: 'clear'
    });
    expect(repository.read().backgroundChecks.get(background.backgroundCheckId)).toEqual({
      id: background.backgroundCheckId,
      offerId,
      status: 'clear',
      initiatedAt: TEST_TIMESTAMP,
      completedAt: TEST_TIMESTAMP
    });

    const benefitsInput = {
      offerId,
      planSelections: {
        medical: 'medical-plus',
        dental: 'dental-basic',
        vision: 'vision-plus'
      }
    };
    const benefits = await invokeAndAudit(
      service,
      'enroll_benefits',
      benefitsInput,
      candidate
    );
    expect(benefits).toEqual({ enrollmentId: expect.any(String) });
    expect(repository.read().benefitsEnrollments.get(benefits.enrollmentId)).toEqual({
      id: benefits.enrollmentId,
      offerId,
      planSelections: benefitsInput.planSelections,
      enrolledAt: TEST_TIMESTAMP
    });

    const checklist = await invokeAndAudit(
      service,
      'generate_onboarding_checklist',
      { offerId },
      recruiter
    );
    expect(checklist.tasks).toHaveLength(3);
    expect(checklist.tasks.map(({ dueDate }) => dueDate)).toEqual([
      '2026-09-07T09:00:00.000Z',
      '2026-09-10T09:00:00.000Z',
      '2026-09-14T09:00:00.000Z'
    ]);
    expect(checklist.tasks).toEqual(
      [...repository.read().onboardingTasks.values()].map(
        ({ id, taskName, dueDate }) => ({ taskId: id, taskName, dueDate })
      )
    );
    expect(
      [...repository.read().onboardingTasks.values()].every(
        (task) => task.offerId === offerId && task.status === 'pending'
      )
    ).toBe(true);
    expect(repository.read().applications.get(applicationId)?.status).toBe('onboarding');

    const beforeFinalStatus = domainSnapshot(repository.read());
    const finalStatus = await invokeAndAudit(
      service,
      'get_onboarding_status',
      { offerId },
      candidate
    );
    expect(finalStatus).toEqual({
      backgroundCheckStatus: 'clear',
      benefitsEnrolled: true,
      taskCompletion: { done: 0, total: 3 },
      completionPercentage: 0
    });
    expect(domainSnapshot(repository.read())).toEqual(beforeFinalStatus);

    const activityNames = repository.read().activityLog.map((entry) => entry.toolName);
    expect(activityNames).toEqual([
      'create_job_requisition',
      'search_candidates',
      'get_candidate_profile',
      'submit_application',
      'get_candidate_profile',
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
    ]);
    expect(new Set(activityNames)).toEqual(
      new Set(LEGACY_OPERATION_NAMES)
    );
    expect(repository.read().applications.get(applicationId)?.status).toBe('onboarding');
  });

  it('covers the decline and counter lifecycle branches without cross-branch mutation', async () => {
    const branchCases = [
      {
        decision: 'decline' as const,
        expectedOfferStatus: 'declined' as const,
        expectedApplicationStatus: 'offer_declined' as const
      },
      {
        decision: 'counter' as const,
        expectedOfferStatus: 'countered' as const,
        expectedApplicationStatus: 'offer_sent' as const
      }
    ];

    for (const branch of branchCases) {
      const { repository } = createTestContext({
        seed: seedWithApplication('offer_sent', { offerStatus: 'sent' })
      });
      const service = new OperationService(repository, defaultOperationHandlers);
      const input = branch.decision === 'counter'
        ? { offerId: 'regression-offer', decision: branch.decision, counterAmount: 180000 }
        : { offerId: 'regression-offer', decision: branch.decision };

      const output = await invokeAndAudit(
        service,
        'respond_to_offer',
        input,
        candidate
      );
      expect(output).toEqual({
        offerId: 'regression-offer',
        status: branch.expectedOfferStatus
      });
      expect(repository.read().offers.get('regression-offer')).toMatchObject({
        status: branch.expectedOfferStatus,
        respondedAt: TEST_TIMESTAMP,
        ...(branch.decision === 'counter' ? { counterAmount: 180000 } : {})
      });
      expect(repository.read().applications.get('regression-application')?.status).toBe(
        branch.expectedApplicationStatus
      );

      if (branch.decision === 'decline') {
        const beforeRetry = domainSnapshot(repository.read());
        const retryInput = { offerId: 'regression-offer', decision: 'accept' as const };
        const retryError = await captureError(
          service.invoke('respond_to_offer', retryInput, candidate)
        );
        expect(retryError.status).toBe(409);
        expect(domainSnapshot(repository.read())).toEqual(beforeRetry);
        expect(repository.read().activityLog).toHaveLength(2);
        expect(repository.read().activityLog.at(-1)).toMatchObject({
          toolName: 'respond_to_offer',
          input: retryInput,
          output: retryError.toPayload(),
          timestamp: TEST_TIMESTAMP
        });
      }
    }

    for (const [from, targets] of Object.entries(APPLICATION_TRANSITIONS) as Array<[
      ApplicationRecord['status'],
      readonly ApplicationRecord['status'][]
    ]>) {
      for (const target of targets) {
        expect(canTransition(from, target)).toBe(true);
      }
      expect(canTransition(from, from)).toBe(false);
    }
    expect(canTransition('offer_accepted', 'rejected')).toBe(false);
    expect(canTransition('onboarding', 'offer_sent')).toBe(false);
  });

  const invalidCases: Array<{
    name: string;
    operation: OperationName;
    input: Record<string, unknown>;
    status: 400 | 404 | 409;
    seed?: ReturnType<typeof createSeed>;
  }> = [
    {
      name: 'rejects an invalid requisition before creating a job',
      operation: 'create_job_requisition',
      input: {
        title: 'Platform Engineer',
        department: 'Infrastructure',
        requirements: [],
        compBand: { min: 150000, max: 120000, currency: 'USD' }
      },
      status: 400
    },
    {
      name: 'rejects malformed candidate search input',
      operation: 'search_candidates',
      input: { query: 42 },
      status: 400
    },
    {
      name: 'rejects a missing candidate profile',
      operation: 'get_candidate_profile',
      input: { candidateId: 'missing-candidate' },
      status: 404
    },
    {
      name: 'rejects a duplicate application',
      operation: 'submit_application',
      input: {
        candidateId: 'cand-1',
        jobId: 'job-1',
        resumeText: 'Another tailored resume'
      },
      status: 409,
      seed: seedWithApplication()
    },
    {
      name: 'rejects screening after the application has already been screened',
      operation: 'screen_candidate',
      input: { applicationId: 'regression-application' },
      status: 409,
      seed: seedWithApplication('screened')
    },
    {
      name: 'rejects a FAQ lookup for a missing job',
      operation: 'answer_candidate_faq',
      input: { jobId: 'missing-job', question: 'What is the salary range?' },
      status: 404
    },
    {
      name: 'rejects a reversed availability range',
      operation: 'check_interviewer_availability',
      input: {
        panelId: 'panel-1',
        dateRange: {
          start: '2026-09-02T00:00:00Z',
          end: '2026-09-01T00:00:00Z'
        }
      },
      status: 400
    },
    {
      name: 'rejects proposals for a missing application',
      operation: 'propose_interview_slots',
      input: { applicationId: 'missing-application' },
      status: 404
    },
    {
      name: 'rejects booking a slot that was not proposed',
      operation: 'book_interview',
      input: {
        applicationId: 'regression-application',
        slot: '2026-10-01T10:00:00Z'
      },
      status: 409,
      seed: seedWithApplication('screened', { interviewStatus: 'proposed' })
    },
    {
      name: 'rejects an interview kit lookup for a missing job',
      operation: 'get_interview_kit',
      input: { jobId: 'missing-job' },
      status: 404
    },
    {
      name: 'rejects feedback for an unbooked interview',
      operation: 'submit_interview_feedback',
      input: {
        interviewId: 'regression-interview',
        interviewer: 'interviewer-1',
        competencyScores: { design: 4 },
        recommendation: 'yes',
        comments: 'Not ready to score'
      },
      status: 409,
      seed: seedWithApplication('screened', { interviewStatus: 'proposed' })
    },
    {
      name: 'rejects a panel summary for a missing application',
      operation: 'get_panel_feedback_summary',
      input: { applicationId: 'missing-application' },
      status: 404
    },
    {
      name: 'rejects a negative offer amount',
      operation: 'generate_offer',
      input: { applicationId: 'regression-application', compAmount: -1 },
      status: 400,
      seed: seedWithApplication('interviewing')
    },
    {
      name: 'rejects sending an offer for a non-interviewing application',
      operation: 'send_offer',
      input: { offerId: 'regression-offer' },
      status: 409,
      seed: seedWithApplication('applied', { offerStatus: 'draft' })
    },
    {
      name: 'rejects a counter response without an amount',
      operation: 'respond_to_offer',
      input: { offerId: 'regression-offer', decision: 'counter' },
      status: 400,
      seed: seedWithApplication('offer_sent', { offerStatus: 'sent' })
    },
    {
      name: 'rejects a background check before offer acceptance',
      operation: 'initiate_background_check',
      input: { offerId: 'regression-offer' },
      status: 409,
      seed: seedWithApplication('offer_sent', { offerStatus: 'sent' })
    },
    {
      name: 'rejects a benefits selection outside the plan catalog',
      operation: 'enroll_benefits',
      input: {
        offerId: 'regression-offer',
        planSelections: {
          medical: 'unknown-medical',
          dental: 'dental-basic',
          vision: 'vision-basic'
        }
      },
      status: 400,
      seed: seedWithApplication('offer_accepted', { offerStatus: 'accepted' })
    },
    {
      name: 'rejects checklist generation before offer acceptance',
      operation: 'generate_onboarding_checklist',
      input: { offerId: 'regression-offer' },
      status: 409,
      seed: seedWithApplication('offer_sent', { offerStatus: 'sent' })
    },
    {
      name: 'rejects onboarding status for a missing offer',
      operation: 'get_onboarding_status',
      input: { offerId: 'missing-offer' },
      status: 404
    }
  ];

  it.each(invalidCases)(
    '$name returns $status, rolls back domain records, and writes one failed audit entry',
    async ({ operation, input, status, seed }) => {
      const { repository } = createTestContext({ seed: seed ?? createSeed() });
      const service = new OperationService(repository, defaultOperationHandlers);
      const before = repository.read();
      const error = await captureError(
        service.invoke(operation, input as never, recruiter)
      );
      const after = repository.read();

      expect(error.status).toBe(status);
      expect(domainSnapshot(after)).toEqual(domainSnapshot(before));
      expect(after.activityLog).toHaveLength(before.activityLog.length + 1);
      expect(after.revision).toBe(before.revision + 1);
      expect(after.activityLog.at(-1)).toMatchObject({
        toolName: operation,
        actorType: recruiter.actorType,
        actorId: recruiter.actorId,
        input,
        output: error.toPayload(),
        timestamp: TEST_TIMESTAMP
      });
    }
  );
});
