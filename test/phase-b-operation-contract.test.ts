import { describe, expect, it } from 'vitest';
import type {
  ApplicationRecord,
  InterviewRecord,
  ScorecardRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import { ConflictError, PipelineError } from '../src/shared/errors';
import { OperationService, type OperationHandlerMap } from '../src/server/operationService';
import { checkInterviewerAvailability } from '../src/server/operations/checkInterviewerAvailability';
import { proposeInterviewSlots } from '../src/server/operations/proposeInterviewSlots';
import { bookInterview } from '../src/server/operations/bookInterview';
import { getInterviewKit } from '../src/server/operations/getInterviewKit';
import { submitInterviewFeedback } from '../src/server/operations/submitInterviewFeedback';
import { getPanelFeedbackSummary } from '../src/server/operations/getPanelFeedbackSummary';
import { createSeed } from '../src/server/seed';
import {
  TEST_TIMESTAMP,
  createTestContext
} from './factories';

const phaseBHandlers: OperationHandlerMap = {
  check_interviewer_availability: checkInterviewerAvailability,
  propose_interview_slots: proposeInterviewSlots,
  book_interview: bookInterview,
  get_interview_kit: getInterviewKit,
  submit_interview_feedback: submitInterviewFeedback,
  get_panel_feedback_summary: getPanelFeedbackSummary
};

function applicationFixture(
  status: ApplicationRecord['status'] = 'screened'
): ApplicationRecord {
  return {
    id: 'application-phase-b',
    candidateId: 'cand-1',
    jobId: 'job-1',
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

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

function expectSingleAudit(
  repository: ReturnType<typeof createTestContext>['repository'],
  operation: string,
  input: Record<string, unknown>,
  output: unknown
): void {
  const state = repository.read();
  expect(state.activityLog).toHaveLength(1);
  expect(state.activityLog[0]).toMatchObject({
    toolName: operation,
    actorType: 'human_ui',
    actorId: 'test-recruiter',
    input,
    output,
    timestamp: TEST_TIMESTAMP
  });
  expect(state.revision).toBe(1);
}

function expectSingleFailureAudit(
  repository: ReturnType<typeof createTestContext>['repository'],
  operation: string,
  input: Record<string, unknown>,
  error: PipelineError
): void {
  expectSingleAudit(repository, operation, input, error.toPayload());
}

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected operation to fail');
}

function seedWithApplicationAndInterviews(
  status: ApplicationRecord['status'] = 'screened',
  interviewStatuses: InterviewRecord['status'][] = ['proposed', 'proposed', 'proposed']
) {
  const seed = createSeed();
  const application = applicationFixture(status);
  seed.applications = new Map([[application.id, application]]);
  seed.interviews = new Map(
    interviewStatuses.map((interviewStatus, index) => {
      const interview: InterviewRecord = {
        id: `phase-b-interview-${index}`,
        applicationId: application.id,
        panelId: 'panel-1',
        slot: `2026-09-0${index + 1}T10:00:00Z`,
        status: interviewStatus
      };
      return [interview.id, interview];
    })
  );
  return { seed, application };
}

describe('Phase B operation contracts, errors, activity, and state', () => {
  it('checks common availability successfully and preserves domain state', async () => {
    const { repository, actor } = createTestContext();
    const service = new OperationService(repository, phaseBHandlers);
    const input = {
      panelId: 'panel-1',
      dateRange: {
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-04T00:00:00Z'
      }
    };
    const before = repository.read();
    const output = await service.invoke('check_interviewer_availability', input, actor);

    expect(output).toEqual({
      commonFreeSlots: [
        '2026-09-01T10:00:00Z',
        '2026-09-01T14:00:00Z',
        '2026-09-02T11:00:00Z',
        '2026-09-02T15:00:00Z',
        '2026-09-03T09:00:00Z'
      ]
    });
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));
    expectSingleAudit(repository, 'check_interviewer_availability', input, output);
  });

  it('returns 400 for invalid availability ranges and 404 for missing panels', async () => {
    const invalidContext = createTestContext();
    const invalidService = new OperationService(invalidContext.repository, phaseBHandlers);
    const invalidInput = {
      panelId: 'panel-1',
      dateRange: {
        start: '2026-09-02T00:00:00Z',
        end: '2026-09-01T00:00:00Z'
      }
    };
    const invalidError = await captureError(
      invalidService.invoke('check_interviewer_availability', invalidInput, invalidContext.actor)
    );
    expect(invalidError.status).toBe(400);
    expect(invalidContext.repository.read().panels).toEqual(createSeed().panels);
    expect(invalidContext.repository.read().activityLog).toHaveLength(1);

    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseBHandlers);
    const missingInput = {
      panelId: 'missing-panel',
      dateRange: {
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-02T00:00:00Z'
      }
    };
    const missingError = await captureError(
      missingService.invoke('check_interviewer_availability', missingInput, missingContext.actor)
    );
    expect(missingError.status).toBe(404);
    expect(missingContext.repository.read().panels).toEqual(createSeed().panels);
    expect(missingContext.repository.read().activityLog).toHaveLength(1);
  });

  it('proposes up to three slots with exact output-to-record correspondence', async () => {
    const { seed, application } = seedWithApplicationAndInterviews('screened', []);
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseBHandlers);
    const output = await service.invoke(
      'propose_interview_slots',
      { applicationId: application.id },
      actor
    );
    const records = [...repository.read().interviews.values()];

    expect(output.proposedSlots).toHaveLength(3);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.slot)).toEqual(
      output.proposedSlots.map((slot) => slot.slot)
    );
    expect(records.every((record) => record.status === 'proposed')).toBe(true);
    expect(records.every((record) => record.applicationId === application.id)).toBe(true);
    expectSingleAudit(repository, 'propose_interview_slots', { applicationId: application.id }, output);
  });

  it('returns 404 for a missing application or an application without a panel', async () => {
    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseBHandlers);
    const missingInput = { applicationId: 'missing-application' };
    const missingError = await captureError(
      missingService.invoke('propose_interview_slots', missingInput, missingContext.actor)
    );
    expect(missingError.status).toBe(404);
    expect(missingContext.repository.read().applications).toEqual(createSeed().applications);
    expect(missingContext.repository.read().activityLog).toHaveLength(1);

    const seed = createSeed();
    const application = applicationFixture();
    seed.applications = new Map([[application.id, application]]);
    seed.panels = new Map();
    const noPanelContext = createTestContext({ seed });
    const noPanelService = new OperationService(noPanelContext.repository, phaseBHandlers);
    const noPanelError = await captureError(
      noPanelService.invoke(
        'propose_interview_slots',
        { applicationId: application.id },
        noPanelContext.actor
      )
    );
    expect(noPanelError.status).toBe(404);
    expect(noPanelContext.repository.read().interviews.size).toBe(0);
    expect(noPanelContext.repository.read().activityLog).toHaveLength(1);
  });

  it('books one proposal, cancels siblings, transitions the application, and audits once', async () => {
    const { seed, application } = seedWithApplicationAndInterviews();
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseBHandlers);
    const input = {
      applicationId: application.id,
      slot: '2026-09-02T10:00:00Z'
    };
    const output = await service.invoke('book_interview', input, actor);
    const state = repository.read();

    expect(output).toEqual({
      interviewId: 'phase-b-interview-1',
      status: 'booked'
    });
    expect(state.interviews.get('phase-b-interview-1')?.status).toBe('booked');
    expect(
      [...state.interviews.values()]
        .filter((interview) => interview.id !== 'phase-b-interview-1')
        .every((interview) => interview.status === 'cancelled')
    ).toBe(true);
    expect(state.applications.get(application.id)?.status).toBe('interviewing');
    expectSingleAudit(repository, 'book_interview', input, output);
  });

  it('returns 409 for a slot mismatch and preserves all domain records', async () => {
    const { seed, application } = seedWithApplicationAndInterviews();
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseBHandlers);
    const before = repository.read();
    const input = {
      applicationId: application.id,
      slot: '2026-10-01T10:00:00Z'
    };
    const error = await captureError(service.invoke('book_interview', input, actor));

    expect(error.status).toBe(409);
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));
    expect(repository.read().activityLog).toHaveLength(1);
    expect(repository.read().activityLog[0].output).toEqual(error.toPayload());
  });

  it('returns 400 for malformed slots and 404 for missing applications before mutating booking state', async () => {
    const malformed = seedWithApplicationAndInterviews();
    const malformedContext = createTestContext({ seed: malformed.seed });
    const malformedService = new OperationService(
      malformedContext.repository,
      phaseBHandlers
    );
    const malformedInput = {
      applicationId: malformed.application.id,
      slot: 'not-a-timestamp'
    };
    const malformedBefore = malformedContext.repository.read();
    const malformedError = await captureError(
      malformedService.invoke(
        'book_interview',
        malformedInput,
        malformedContext.actor
      )
    );

    expect(malformedError.status).toBe(400);
    expect(domainSnapshot(malformedContext.repository.read())).toEqual(
      domainSnapshot(malformedBefore)
    );
    expectSingleFailureAudit(
      malformedContext.repository,
      'book_interview',
      malformedInput,
      malformedError
    );

    const missingContext = createTestContext();
    const missingService = new OperationService(
      missingContext.repository,
      phaseBHandlers
    );
    const missingInput = {
      applicationId: 'missing-application',
      slot: '2026-09-01T10:00:00Z'
    };
    const missingBefore = missingContext.repository.read();
    const missingError = await captureError(
      missingService.invoke('book_interview', missingInput, missingContext.actor)
    );

    expect(missingError.status).toBe(404);
    expect(domainSnapshot(missingContext.repository.read())).toEqual(
      domainSnapshot(missingBefore)
    );
    expectSingleFailureAudit(
      missingContext.repository,
      'book_interview',
      missingInput,
      missingError
    );
  });

  it('returns 409 rather than skipping lifecycle stages while booking', async () => {
    const { seed, application } = seedWithApplicationAndInterviews('applied');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseBHandlers);
    const before = repository.read();
    const error = await captureError(
      service.invoke(
        'book_interview',
        { applicationId: application.id, slot: '2026-09-01T10:00:00Z' },
        actor
      )
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.status).toBe(409);
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));
  });

  it('returns role-specific interview kits read-only and 404 for unknown jobs', async () => {
    const context = createTestContext();
    const service = new OperationService(context.repository, phaseBHandlers);
    const before = context.repository.read();
    const output = await service.invoke(
      'get_interview_kit',
      { jobId: 'job-1' },
      context.actor
    );
    expect(output.competencies).toHaveLength(4);
    expect(output.competencies.every((group) => group.questions.length > 0)).toBe(true);
    expect(domainSnapshot(context.repository.read())).toEqual(domainSnapshot(before));
    expectSingleAudit(context.repository, 'get_interview_kit', { jobId: 'job-1' }, output);

    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseBHandlers);
    const error = await captureError(
      missingService.invoke('get_interview_kit', { jobId: 'missing-job' }, missingContext.actor)
    );
    expect(error.status).toBe(404);
    expect(missingContext.repository.read().jobs).toEqual(createSeed().jobs);
  });

  function feedbackSeed(status: InterviewRecord['status'] = 'booked') {
    const seed = createSeed();
    const application = applicationFixture('interviewing');
    const interview: InterviewRecord = {
      id: 'feedback-interview',
      applicationId: application.id,
      panelId: 'panel-1',
      slot: '2026-09-01T10:00:00Z',
      status
    };
    seed.applications = new Map([[application.id, application]]);
    seed.interviews = new Map([[interview.id, interview]]);
    return { seed, application, interview };
  }

  it('creates a scorecard, completes the interview, and returns its ID', async () => {
    const { seed, interview } = feedbackSeed();
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseBHandlers);
    const input = {
      interviewId: interview.id,
      interviewer: 'interviewer-1',
      competencyScores: { design: 4, coding: 5 },
      recommendation: 'yes' as const,
      comments: 'Strong systems thinking'
    };
    const output = await service.invoke('submit_interview_feedback', input, actor);
    const state = repository.read();
    const scorecard = state.scorecards.get(output.scorecardId);

    expect(output).toEqual({ scorecardId: expect.any(String) });
    expect(scorecard).toMatchObject({
      interviewId: interview.id,
      interviewer: input.interviewer,
      competencyScores: input.competencyScores,
      recommendation: input.recommendation,
      comments: input.comments,
      submittedAt: TEST_TIMESTAMP
    });
    expect(state.interviews.get(interview.id)?.status).toBe('completed');
    expectSingleAudit(repository, 'submit_interview_feedback', input, output);
  });

  it('returns 400 for invalid scores/recommendations and 404/409 for interview state errors', async () => {
    const invalidContext = createTestContext({ seed: feedbackSeed().seed });
    const invalidService = new OperationService(invalidContext.repository, phaseBHandlers);
    const invalidScoreInput = {
      interviewId: 'feedback-interview',
      interviewer: 'interviewer-1',
      competencyScores: { design: 6 },
      recommendation: 'yes' as const,
      comments: 'Comments'
    };
    const scoreError = await captureError(
      invalidService.invoke('submit_interview_feedback', invalidScoreInput, invalidContext.actor)
    );
    expect(scoreError.status).toBe(400);
    expect(invalidContext.repository.read().scorecards).toHaveLength(0);

    const invalidRecommendationInput = {
      ...invalidScoreInput,
      competencyScores: { design: 4 },
      recommendation: 'maybe'
    } as never;
    const recommendationError = await captureError(
      invalidService.invoke(
        'submit_interview_feedback',
        invalidRecommendationInput,
        invalidContext.actor
      )
    );
    expect(recommendationError.status).toBe(400);
    expect(invalidContext.repository.read().scorecards).toHaveLength(0);

    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseBHandlers);
    const missingError = await captureError(
      missingService.invoke(
        'submit_interview_feedback',
        {
          interviewId: 'missing-interview',
          interviewer: 'interviewer-1',
          competencyScores: { design: 4 },
          recommendation: 'yes',
          comments: 'Comments'
        },
        missingContext.actor
      )
    );
    expect(missingError.status).toBe(404);

    const conflictContext = createTestContext({ seed: feedbackSeed('proposed').seed });
    const conflictService = new OperationService(conflictContext.repository, phaseBHandlers);
    const conflictError = await captureError(
      conflictService.invoke(
        'submit_interview_feedback',
        {
          interviewId: 'feedback-interview',
          interviewer: 'interviewer-1',
          competencyScores: { design: 4 },
          recommendation: 'yes',
          comments: 'Comments'
        },
        conflictContext.actor
      )
    );
    expect(conflictError.status).toBe(409);
    expect(conflictContext.repository.read().scorecards).toHaveLength(0);
  });

  it('joins panel scorecards, calculates aggregates, and remains read-only', async () => {
    const seed = createSeed();
    const application = applicationFixture('interviewing');
    const interviews: InterviewRecord[] = [
      {
        id: 'summary-interview-1',
        applicationId: application.id,
        panelId: 'panel-1',
        slot: '2026-09-01T10:00:00Z',
        status: 'completed'
      },
      {
        id: 'summary-interview-2',
        applicationId: application.id,
        panelId: 'panel-1',
        slot: '2026-09-02T10:00:00Z',
        status: 'completed'
      }
    ];
    const scorecards: ScorecardRecord[] = [
      {
        id: 'summary-scorecard-1',
        interviewId: interviews[0].id,
        interviewer: 'interviewer-1',
        competencyScores: { design: 4, coding: 5 },
        recommendation: 'yes',
        comments: 'Good',
        submittedAt: TEST_TIMESTAMP
      },
      {
        id: 'summary-scorecard-2',
        interviewId: interviews[1].id,
        interviewer: 'interviewer-2',
        competencyScores: { design: 2 },
        recommendation: 'no',
        comments: 'Needs growth',
        submittedAt: TEST_TIMESTAMP
      }
    ];
    seed.applications = new Map([[application.id, application]]);
    seed.interviews = new Map(interviews.map((interview) => [interview.id, interview]));
    seed.scorecards = new Map(scorecards.map((scorecard) => [scorecard.id, scorecard]));
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseBHandlers);
    const before = repository.read();
    const input = { applicationId: application.id };
    const output = await service.invoke('get_panel_feedback_summary', input, actor);

    expect(output).toEqual({
      averageScores: { design: 3, coding: 5 },
      recommendationTally: { yes: 1, no: 1 },
      scorecards
    });
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));
    expectSingleAudit(repository, 'get_panel_feedback_summary', input, output);

    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseBHandlers);
    const missingError = await captureError(
      missingService.invoke(
        'get_panel_feedback_summary',
        { applicationId: 'missing-application' },
        missingContext.actor
      )
    );
    expect(missingError.status).toBe(404);
  });

  it('audits one structured failure for every Phase B operation and preserves domain state', async () => {
    const availabilityContext = createTestContext();
    const availabilityService = new OperationService(
      availabilityContext.repository,
      phaseBHandlers
    );
    const availabilityInput = {
      panelId: 'missing-panel',
      dateRange: {
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-02T00:00:00Z'
      }
    };
    const availabilityBefore = availabilityContext.repository.read();
    const availabilityError = await captureError(
      availabilityService.invoke(
        'check_interviewer_availability',
        availabilityInput,
        availabilityContext.actor
      )
    );
    expect(availabilityError.status).toBe(404);
    expect(domainSnapshot(availabilityContext.repository.read())).toEqual(
      domainSnapshot(availabilityBefore)
    );
    expectSingleFailureAudit(
      availabilityContext.repository,
      'check_interviewer_availability',
      availabilityInput,
      availabilityError
    );

    const proposalContext = createTestContext();
    const proposalService = new OperationService(
      proposalContext.repository,
      phaseBHandlers
    );
    const proposalInput = { applicationId: 'missing-application' };
    const proposalBefore = proposalContext.repository.read();
    const proposalError = await captureError(
      proposalService.invoke(
        'propose_interview_slots',
        proposalInput,
        proposalContext.actor
      )
    );
    expect(proposalError.status).toBe(404);
    expect(domainSnapshot(proposalContext.repository.read())).toEqual(
      domainSnapshot(proposalBefore)
    );
    expectSingleFailureAudit(
      proposalContext.repository,
      'propose_interview_slots',
      proposalInput,
      proposalError
    );

    const bookingContext = createTestContext();
    const bookingService = new OperationService(
      bookingContext.repository,
      phaseBHandlers
    );
    const bookingInput = {
      applicationId: 'missing-application',
      slot: '2026-09-01T10:00:00Z'
    };
    const bookingBefore = bookingContext.repository.read();
    const bookingError = await captureError(
      bookingService.invoke('book_interview', bookingInput, bookingContext.actor)
    );
    expect(bookingError.status).toBe(404);
    expect(domainSnapshot(bookingContext.repository.read())).toEqual(
      domainSnapshot(bookingBefore)
    );
    expectSingleFailureAudit(
      bookingContext.repository,
      'book_interview',
      bookingInput,
      bookingError
    );

    const kitContext = createTestContext();
    const kitService = new OperationService(kitContext.repository, phaseBHandlers);
    const kitInput = { jobId: 'missing-job' };
    const kitBefore = kitContext.repository.read();
    const kitError = await captureError(
      kitService.invoke('get_interview_kit', kitInput, kitContext.actor)
    );
    expect(kitError.status).toBe(404);
    expect(domainSnapshot(kitContext.repository.read())).toEqual(
      domainSnapshot(kitBefore)
    );
    expectSingleFailureAudit(kitContext.repository, 'get_interview_kit', kitInput, kitError);

    const feedbackContext = createTestContext();
    const feedbackService = new OperationService(
      feedbackContext.repository,
      phaseBHandlers
    );
    const feedbackInput = {
      interviewId: 'missing-interview',
      interviewer: 'interviewer-1',
      competencyScores: { design: 4 },
      recommendation: 'yes' as const,
      comments: 'Comments'
    };
    const feedbackBefore = feedbackContext.repository.read();
    const feedbackError = await captureError(
      feedbackService.invoke(
        'submit_interview_feedback',
        feedbackInput,
        feedbackContext.actor
      )
    );
    expect(feedbackError.status).toBe(404);
    expect(domainSnapshot(feedbackContext.repository.read())).toEqual(
      domainSnapshot(feedbackBefore)
    );
    expectSingleFailureAudit(
      feedbackContext.repository,
      'submit_interview_feedback',
      feedbackInput,
      feedbackError
    );

    const summaryContext = createTestContext();
    const summaryService = new OperationService(
      summaryContext.repository,
      phaseBHandlers
    );
    const summaryInput = { applicationId: 'missing-application' };
    const summaryBefore = summaryContext.repository.read();
    const summaryError = await captureError(
      summaryService.invoke(
        'get_panel_feedback_summary',
        summaryInput,
        summaryContext.actor
      )
    );
    expect(summaryError.status).toBe(404);
    expect(domainSnapshot(summaryContext.repository.read())).toEqual(
      domainSnapshot(summaryBefore)
    );
    expectSingleFailureAudit(
      summaryContext.repository,
      'get_panel_feedback_summary',
      summaryInput,
      summaryError
    );
  });
});
