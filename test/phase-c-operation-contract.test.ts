import { describe, expect, it } from 'vitest';
import type {
  ApplicationRecord,
  BackgroundCheckRecord,
  BenefitsEnrollmentRecord,
  InterviewRecord,
  OfferRecord,
  OnboardingTaskRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import { PipelineError } from '../src/shared/errors';
import { OperationService, type OperationHandlerMap } from '../src/server/operationService';
import { generateOffer } from '../src/server/operations/generateOffer';
import { sendOffer } from '../src/server/operations/sendOffer';
import { respondToOffer } from '../src/server/operations/respondToOffer';
import { initiateBackgroundCheck } from '../src/server/operations/initiateBackgroundCheck';
import { enrollBenefits } from '../src/server/operations/enrollBenefits';
import { generateOnboardingChecklist } from '../src/server/operations/generateOnboardingChecklist';
import { getOnboardingStatus } from '../src/server/operations/getOnboardingStatus';
import { createSeed } from '../src/server/seed';
import { TEST_TIMESTAMP, createTestContext } from './factories';

const phaseCHandlers: OperationHandlerMap = {
  generate_offer: generateOffer,
  send_offer: sendOffer,
  respond_to_offer: respondToOffer,
  initiate_background_check: initiateBackgroundCheck,
  enroll_benefits: enrollBenefits,
  generate_onboarding_checklist: generateOnboardingChecklist,
  get_onboarding_status: getOnboardingStatus
};

function applicationFixture(
  status: ApplicationRecord['status'] = 'interviewing',
  id = 'phase-c-application'
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

function offerFixture(
  status: OfferRecord['status'] = 'draft',
  applicationId = 'phase-c-application'
): OfferRecord {
  return {
    id: 'phase-c-offer',
    applicationId,
    compAmount: 175000,
    currency: 'USD',
    status,
    counterAmount: null,
    sentAt: status === 'sent' ? TEST_TIMESTAMP : null,
    respondedAt: null
  };
}

function seedWithOffer(
  applicationStatus: ApplicationRecord['status'] = 'interviewing',
  offerStatus: OfferRecord['status'] = 'draft'
) {
  const seed = createSeed();
  const application = applicationFixture(applicationStatus);
  const offer = offerFixture(offerStatus, application.id);
  seed.applications = new Map([[application.id, application]]);
  seed.offers = new Map([[offer.id, offer]]);
  return { seed, application, offer };
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

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected operation to fail');
}

describe('Phase C operation contracts, errors, activity, and state', () => {
  it('generates in-band and out-of-band drafts without an offer-status prerequisite', async () => {
    const { repository, actor } = createTestContext({
      seed: seedWithOffer('applied').seed
    });
    const service = new OperationService(repository, phaseCHandlers);
    const input = { applicationId: 'phase-c-application', compAmount: 200000 };
    const output = await service.invoke('generate_offer', input, actor);
    const state = repository.read();
    const offer = state.offers.get(output.offerId);

    expect(output).toEqual({ offerId: 'offer-1', status: 'draft' });
    expect(offer).toEqual({
      id: 'offer-1',
      applicationId: input.applicationId,
      compAmount: input.compAmount,
      currency: 'USD',
      status: 'draft',
      counterAmount: null,
      sentAt: null,
      respondedAt: null,
      compensationWarning:
        'Compensation amount 200000 is outside the USD band of 160000-190000.'
    });
    expectSingleAudit(repository, 'generate_offer', input, output);
  });

  it('rejects invalid or missing offer-generation references before mutation', async () => {
    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseCHandlers);
    const missingError = await captureError(
      missingService.invoke(
        'generate_offer',
        { applicationId: 'missing-application', compAmount: 170000 },
        missingContext.actor
      )
    );
    expect(missingError.status).toBe(404);
    expect(missingContext.repository.read().offers).toHaveLength(0);
    expect(missingContext.repository.read().activityLog[0].output).toEqual(
      missingError.toPayload()
    );

    const invalidContext = createTestContext({ seed: seedWithOffer().seed });
    const invalidService = new OperationService(invalidContext.repository, phaseCHandlers);
    const invalidError = await captureError(
      invalidService.invoke(
        'generate_offer',
        { applicationId: 'phase-c-application', compAmount: -1 },
        invalidContext.actor
      )
    );
    expect(invalidError.status).toBe(400);
    expect(invalidContext.repository.read().offers).toEqual(
      seedWithOffer().seed.offers
    );
    expect(invalidContext.repository.read().activityLog).toHaveLength(1);
  });

  it('sends a draft only for an interviewing application and advances both records', async () => {
    const { seed, application, offer } = seedWithOffer('interviewing', 'draft');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const input = { offerId: offer.id };
    const output = await service.invoke('send_offer', input, actor);
    const state = repository.read();

    expect(output).toEqual({ offerId: offer.id, status: 'sent' });
    expect(state.offers.get(offer.id)).toMatchObject({
      status: 'sent',
      sentAt: TEST_TIMESTAMP
    });
    expect(state.applications.get(application.id)?.status).toBe('offer_sent');
    expectSingleAudit(repository, 'send_offer', input, output);
  });

  it('preserves state for send conflicts and audits the structured error once', async () => {
    const { seed, application, offer } = seedWithOffer('applied', 'draft');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const before = repository.read();
    const input = { offerId: offer.id };
    const error = await captureError(service.invoke('send_offer', input, actor));

    expect(error.status).toBe(409);
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));
    expect(repository.read().activityLog).toHaveLength(1);
    expect(repository.read().activityLog[0].output).toEqual(error.toPayload());
    expect(repository.read().applications.get(application.id)?.status).toBe('applied');
  });

  it.each([
    ['accept', 'accepted', 'offer_accepted'],
    ['decline', 'declined', 'offer_declined'],
    ['counter', 'countered', 'offer_sent']
  ] as const)(
    'applies the %s offer response branch without cross-branch transitions',
    async (decision, expectedOfferStatus, expectedApplicationStatus) => {
      const { seed, application, offer } = seedWithOffer('offer_sent', 'sent');
      const { repository, actor } = createTestContext({ seed });
      const service = new OperationService(repository, phaseCHandlers);
      const input = decision === 'counter'
        ? { offerId: offer.id, decision, counterAmount: 180000 }
        : { offerId: offer.id, decision };
      const output = await service.invoke('respond_to_offer', input, actor);
      const state = repository.read();

      expect(output).toEqual({ offerId: offer.id, status: expectedOfferStatus });
      expect(state.offers.get(offer.id)).toMatchObject({
        status: expectedOfferStatus,
        respondedAt: TEST_TIMESTAMP,
        ...(decision === 'counter' ? { counterAmount: 180000 } : { counterAmount: null })
      });
      expect(state.applications.get(application.id)?.status).toBe(expectedApplicationStatus);
      expectSingleAudit(repository, 'respond_to_offer', input, output);
    }
  );

  it('validates counter amounts and sent-offer/lifecycle preconditions atomically', async () => {
    const missingAmountContext = createTestContext({ seed: seedWithOffer('offer_sent', 'sent').seed });
    const missingAmountService = new OperationService(
      missingAmountContext.repository,
      phaseCHandlers
    );
    const missingAmountError = await captureError(
      missingAmountService.invoke(
        'respond_to_offer',
        { offerId: 'phase-c-offer', decision: 'counter' } as never,
        missingAmountContext.actor
      )
    );
    expect(missingAmountError.status).toBe(400);
    expect(missingAmountContext.repository.read().offers.get('phase-c-offer')?.status).toBe(
      'sent'
    );

    const invalidAmountContext = createTestContext({ seed: seedWithOffer('offer_sent', 'sent').seed });
    const invalidAmountService = new OperationService(
      invalidAmountContext.repository,
      phaseCHandlers
    );
    const invalidAmountError = await captureError(
      invalidAmountService.invoke(
        'respond_to_offer',
        { offerId: 'phase-c-offer', decision: 'counter', counterAmount: -1 },
        invalidAmountContext.actor
      )
    );
    expect(invalidAmountError.status).toBe(400);
    expect(invalidAmountContext.repository.read().offers.get('phase-c-offer')?.status).toBe(
      'sent'
    );

    const nonSentContext = createTestContext({ seed: seedWithOffer('offer_sent', 'draft').seed });
    const nonSentService = new OperationService(nonSentContext.repository, phaseCHandlers);
    const before = nonSentContext.repository.read();
    const nonSentError = await captureError(
      nonSentService.invoke(
        'respond_to_offer',
        { offerId: 'phase-c-offer', decision: 'accept' },
        nonSentContext.actor
      )
    );
    expect(nonSentError.status).toBe(409);
    expect(domainSnapshot(nonSentContext.repository.read())).toEqual(domainSnapshot(before));

    const lifecycleContext = createTestContext({ seed: seedWithOffer('interviewing', 'sent').seed });
    const lifecycleService = new OperationService(lifecycleContext.repository, phaseCHandlers);
    const lifecycleBefore = lifecycleContext.repository.read();
    const lifecycleError = await captureError(
      lifecycleService.invoke(
        'respond_to_offer',
        { offerId: 'phase-c-offer', decision: 'accept' },
        lifecycleContext.actor
      )
    );
    expect(lifecycleError.status).toBe(409);
    expect(domainSnapshot(lifecycleContext.repository.read())).toEqual(
      domainSnapshot(lifecycleBefore)
    );
  });

  it('completes accepted-offer background checks and rejects other offer statuses', async () => {
    const { seed, offer } = seedWithOffer('offer_accepted', 'accepted');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const input = { offerId: offer.id };
    const output = await service.invoke('initiate_background_check', input, actor);
    const state = repository.read();
    const check = state.backgroundChecks.get(output.backgroundCheckId);

    expect(output).toEqual({ backgroundCheckId: 'background-check-1', status: 'clear' });
    expect(check).toMatchObject({
      offerId: offer.id,
      status: 'clear',
      initiatedAt: TEST_TIMESTAMP,
      completedAt: TEST_TIMESTAMP
    });
    expectSingleAudit(repository, 'initiate_background_check', input, output);

    const conflictContext = createTestContext({ seed: seedWithOffer('offer_sent', 'sent').seed });
    const conflictService = new OperationService(conflictContext.repository, phaseCHandlers);
    const before = conflictContext.repository.read();
    const error = await captureError(
      conflictService.invoke('initiate_background_check', input, conflictContext.actor)
    );
    expect(error.status).toBe(409);
    expect(domainSnapshot(conflictContext.repository.read())).toEqual(domainSnapshot(before));
  });

  it('validates catalog selections, creates one enrollment, and rejects duplicates', async () => {
    const { seed, offer } = seedWithOffer('offer_accepted', 'accepted');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const input = {
      offerId: offer.id,
      planSelections: {
        medical: 'medical-plus',
        dental: 'dental-basic',
        vision: 'vision-plus'
      }
    };
    const output = await service.invoke('enroll_benefits', input, actor);
    const state = repository.read();
    expect(output).toEqual({ enrollmentId: 'benefits-1' });
    expect(state.benefitsEnrollments.get(output.enrollmentId)).toEqual({
      id: output.enrollmentId,
      offerId: offer.id,
      planSelections: input.planSelections,
      enrolledAt: TEST_TIMESTAMP
    });
    expectSingleAudit(repository, 'enroll_benefits', input, output);

    const duplicateBefore = repository.read();
    const duplicateError = await captureError(service.invoke('enroll_benefits', input, actor));
    expect(duplicateError.status).toBe(409);
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(duplicateBefore));

    const invalidContext = createTestContext({ seed: seedWithOffer().seed });
    const invalidService = new OperationService(invalidContext.repository, phaseCHandlers);
    const invalidInput = {
      offerId: offer.id,
      planSelections: {
        medical: 'unknown-medical',
        dental: 'dental-basic',
        vision: 'vision-basic'
      }
    };
    const invalidError = await captureError(
      invalidService.invoke('enroll_benefits', invalidInput, invalidContext.actor)
    );
    expect(invalidError.status).toBe(400);
    expect(invalidContext.repository.read().benefitsEnrollments).toHaveLength(0);
  });

  it('generates role-specific onboarding tasks, advances the application, and rejects duplicates', async () => {
    const { seed, application, offer } = seedWithOffer('offer_accepted', 'accepted');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const input = { offerId: offer.id };
    const output = await service.invoke('generate_onboarding_checklist', input, actor);
    const state = repository.read();
    const tasks = [...state.onboardingTasks.values()];

    expect(output.tasks).toHaveLength(3);
    expect(tasks).toHaveLength(3);
    expect(tasks.every((task) => task.offerId === offer.id && task.status === 'pending')).toBe(true);
    expect(output.tasks).toEqual(
      tasks.map(({ id, taskName, dueDate }) => ({ taskId: id, taskName, dueDate }))
    );
    expect(state.applications.get(application.id)?.status).toBe('onboarding');
    expect(output.tasks.map((task) => task.dueDate)).toEqual([
      '2026-09-07T09:00:00.000Z',
      '2026-09-10T09:00:00.000Z',
      '2026-09-14T09:00:00.000Z'
    ]);
    expectSingleAudit(repository, 'generate_onboarding_checklist', input, output);

    const before = repository.read();
    const duplicateError = await captureError(
      service.invoke('generate_onboarding_checklist', input, actor)
    );
    expect(duplicateError.status).toBe(409);
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));

    const rejectedContext = createTestContext({ seed: seedWithOffer('offer_sent', 'sent').seed });
    const rejectedService = new OperationService(rejectedContext.repository, phaseCHandlers);
    const rejectedError = await captureError(
      rejectedService.invoke('generate_onboarding_checklist', input, rejectedContext.actor)
    );
    expect(rejectedError.status).toBe(409);
  });

  it('joins background, benefits, and tasks and returns zero for an empty checklist', async () => {
    const { seed, offer } = seedWithOffer('offer_accepted', 'accepted');
    const backgroundCheck: BackgroundCheckRecord = {
      id: 'background-1',
      offerId: offer.id,
      status: 'clear',
      initiatedAt: TEST_TIMESTAMP,
      completedAt: TEST_TIMESTAMP
    };
    const enrollment: BenefitsEnrollmentRecord = {
      id: 'benefits-1',
      offerId: offer.id,
      planSelections: {
        medical: 'medical-basic',
        dental: 'dental-basic',
        vision: 'vision-basic'
      },
      enrolledAt: TEST_TIMESTAMP
    };
    const tasks: OnboardingTaskRecord[] = [
      {
        id: 'task-1',
        offerId: offer.id,
        taskName: 'One',
        status: 'complete',
        dueDate: TEST_TIMESTAMP
      },
      {
        id: 'task-2',
        offerId: offer.id,
        taskName: 'Two',
        status: 'pending',
        dueDate: TEST_TIMESTAMP
      },
      {
        id: 'task-other-offer',
        offerId: 'other-offer',
        taskName: 'Unrelated task',
        status: 'complete',
        dueDate: TEST_TIMESTAMP
      }
    ];
    seed.backgroundChecks = new Map([[backgroundCheck.id, backgroundCheck]]);
    seed.benefitsEnrollments = new Map([[enrollment.id, enrollment]]);
    seed.onboardingTasks = new Map(tasks.map((task) => [task.id, task]));
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const before = repository.read();
    const input = { offerId: offer.id };
    const output = await service.invoke('get_onboarding_status', input, actor);

    expect(output).toEqual({
      backgroundCheckStatus: 'clear',
      benefitsEnrolled: true,
      taskCompletion: { done: 1, total: 2 },
      completionPercentage: 50
    });
    expect(domainSnapshot(repository.read())).toEqual(domainSnapshot(before));
    expectSingleAudit(repository, 'get_onboarding_status', input, output);

    const emptySeed = seedWithOffer('offer_accepted', 'accepted').seed;
    const emptyContext = createTestContext({ seed: emptySeed });
    const emptyService = new OperationService(emptyContext.repository, phaseCHandlers);
    expect(
      await emptyService.invoke('get_onboarding_status', { offerId: 'phase-c-offer' }, emptyContext.actor)
    ).toEqual({
      backgroundCheckStatus: null,
      benefitsEnrolled: false,
      taskCompletion: { done: 0, total: 0 },
      completionPercentage: 0
    });
  });

  it('omits the compensation warning when a draft is within the requisition band', async () => {
    const { repository, actor } = createTestContext({
      seed: seedWithOffer('applied').seed
    });
    const service = new OperationService(repository, phaseCHandlers);
    const input = { applicationId: 'phase-c-application', compAmount: 175000 };
    const output = await service.invoke('generate_offer', input, actor);
    const offer = repository.read().offers.get(output.offerId);

    expect(output).toEqual({ offerId: 'offer-1', status: 'draft' });
    expect(offer).toMatchObject({
      applicationId: input.applicationId,
      compAmount: input.compAmount,
      currency: 'USD',
      status: 'draft',
      counterAmount: null,
      sentAt: null,
      respondedAt: null
    });
    expect(offer?.compensationWarning).toBeUndefined();
    expectSingleAudit(repository, 'generate_offer', input, output);
  });

  it.each([
    {
      operation: 'generate_offer',
      input: { applicationId: 'missing-application', compAmount: 170000 }
    },
    { operation: 'send_offer', input: { offerId: 'missing-offer' } },
    {
      operation: 'respond_to_offer',
      input: { offerId: 'missing-offer', decision: 'accept' }
    },
    {
      operation: 'initiate_background_check',
      input: { offerId: 'missing-offer' }
    },
    {
      operation: 'enroll_benefits',
      input: {
        offerId: 'missing-offer',
        planSelections: {
          medical: 'medical-basic',
          dental: 'dental-basic',
          vision: 'vision-basic'
        }
      }
    },
    {
      operation: 'generate_onboarding_checklist',
      input: { offerId: 'missing-offer' }
    },
    {
      operation: 'get_onboarding_status',
      input: { offerId: 'missing-offer' }
    }
  ] as const)('records one exact failed audit for a missing %s reference', async ({ operation, input }) => {
    const { repository, actor } = createTestContext();
    const service = new OperationService(repository, phaseCHandlers);
    const before = repository.read();
    const error = await captureError(
      service.invoke(operation, input as never, actor)
    );
    const state = repository.read();
    const [entry] = state.activityLog;

    expect(error.status).toBe(404);
    expect(domainSnapshot(state)).toEqual(domainSnapshot(before));
    expect(state.activityLog).toHaveLength(1);
    expect(state.revision).toBe(1);
    expect(entry).toMatchObject({
      toolName: operation,
      actorType: actor.actorType,
      actorId: actor.actorId,
      timestamp: TEST_TIMESTAMP,
      output: error.toPayload()
    });
    expect(entry.input).toEqual(input);
  });

  it('rejects sending an already-sent offer without changing either record', async () => {
    const { seed, application, offer } = seedWithOffer('interviewing', 'sent');
    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseCHandlers);
    const before = repository.read();
    const input = { offerId: offer.id };
    const error = await captureError(service.invoke('send_offer', input, actor));
    const state = repository.read();

    expect(error.status).toBe(409);
    expect(domainSnapshot(state)).toEqual(domainSnapshot(before));
    expect(state.offers.get(offer.id)).toEqual(offer);
    expect(state.applications.get(application.id)?.status).toBe('interviewing');
    expect(state.activityLog).toHaveLength(1);
    expect(state.activityLog[0]).toMatchObject({
      toolName: 'send_offer',
      actorType: actor.actorType,
      actorId: actor.actorId,
      input,
      output: error.toPayload(),
      timestamp: TEST_TIMESTAMP
    });
    expect(state.revision).toBe(1);
  });
});
