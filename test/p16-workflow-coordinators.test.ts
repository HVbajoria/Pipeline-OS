import type {
  ApplicationRecord,
  OfferRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import { PipelineError } from '../src/shared/errors';
import type {
  CoordinateInterviewWorkflowInput,
  CoordinateOnboardingWorkflowInput,
  OperationInvocation
} from '../src/shared/operations';
import {
  createAuthorizationPolicy,
  createTrustedPrincipal
} from '../src/server/authorization';
import {
  OperationService,
  type OperationHandlerMap
} from '../src/server/operationService';
import {
  coordinateInterviewWorkflow
} from '../src/server/operations/coordinateInterviewWorkflow';
import {
  coordinateOnboardingWorkflow
} from '../src/server/operations/coordinateOnboardingWorkflow';
import { defaultOperationHandlers } from '../src/server/operations';
import { createSeed } from '../src/server/seed';
import {
  TEST_TIMESTAMP,
  createTestContext
} from './factories';

const coordinatorHandlers: OperationHandlerMap = {
  coordinate_interview_workflow: coordinateInterviewWorkflow,
  coordinate_onboarding_workflow: coordinateOnboardingWorkflow
};

function applicationFixture(
  status: ApplicationRecord['status'],
  id = 'p16-application'
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
  applicationId: string,
  status: OfferRecord['status'] = 'accepted',
  id = 'p16-offer'
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

function interviewSeed(status: ApplicationRecord['status'] = 'screened') {
  const seed = createSeed();
  const application = applicationFixture(status);
  seed.applications = new Map([[application.id, application]]);
  return { seed, application };
}

function onboardingSeed(
  applicationStatus: ApplicationRecord['status'] = 'offer_accepted',
  offerStatus: OfferRecord['status'] = 'accepted'
) {
  const seed = createSeed();
  const application = applicationFixture(applicationStatus);
  const offer = offerFixture(application.id, offerStatus);
  seed.applications = new Map([[application.id, application]]);
  seed.offers = new Map([[offer.id, offer]]);
  return { seed, application, offer };
}

function domainSnapshot(state: SharedStateWithCatalogs) {
  return {
    applications: state.applications,
    interviews: state.interviews,
    offers: state.offers,
    onboardingTasks: state.onboardingTasks,
    backgroundChecks: state.backgroundChecks,
    benefitsEnrollments: state.benefitsEnrollments
  };
}

function interviewEnvelope(
  input: CoordinateInterviewWorkflowInput,
  idempotencyKey: string
): OperationInvocation<'coordinate_interview_workflow'> {
  return {
    name: 'coordinate_interview_workflow',
    input,
    actor: { actorType: 'human_ui', actorId: 'test-recruiter' },
    metadata: { idempotencyKey, correlationId: `p16-${idempotencyKey}` }
  };
}

function onboardingEnvelope(
  input: CoordinateOnboardingWorkflowInput,
  idempotencyKey: string
): OperationInvocation<'coordinate_onboarding_workflow'> {
  return {
    name: 'coordinate_onboarding_workflow',
    input,
    actor: { actorType: 'human_ui', actorId: 'test-recruiter' },
    metadata: { idempotencyKey, correlationId: `p16-${idempotencyKey}` }
  };
}

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected operation to fail');
}

describe('P16 canonical workflow coordinators', () => {
  it('registers both canonical handlers without removing the existing workflow primitives', () => {
    expect(defaultOperationHandlers.coordinate_interview_workflow).toBe(
      coordinateInterviewWorkflow
    );
    expect(defaultOperationHandlers.coordinate_onboarding_workflow).toBe(
      coordinateOnboardingWorkflow
    );
    expect(defaultOperationHandlers.propose_interview_slots).toBeDefined();
    expect(defaultOperationHandlers.book_interview).toBeDefined();
    expect(defaultOperationHandlers.generate_onboarding_checklist).toBeDefined();
    expect(defaultOperationHandlers.get_onboarding_status).toBeDefined();
  });

  it('proposes deterministic slots and returns equivalent proposals on replay with a new key', async () => {
    const { seed, application } = interviewSeed();
    const context = createTestContext({ seed, idPrefix: 'p16-interview' });
    const service = new OperationService(context.repository, coordinatorHandlers);
    const input = { applicationId: application.id, action: 'propose_slots' } as const;

    const first = await service.invoke(interviewEnvelope(
      input,
      'proposal-first'
    ));
    const sameKeyReplay = await service.invoke(interviewEnvelope(
      input,
      'proposal-first'
    ));
    const newKeyReplay = await service.invoke(interviewEnvelope(
      input,
      'proposal-second'
    ));

    expect(first).toEqual(sameKeyReplay);
    expect(newKeyReplay).toEqual(first);
    expect(first.proposedSlots).toHaveLength(3);
    expect(first.proposedSlots.map(({ slot }) => slot)).toEqual([
      '2026-09-01T10:00:00Z',
      '2026-09-01T14:00:00Z',
      '2026-09-02T11:00:00Z'
    ]);
    expect([...context.repository.read().interviews.values()]).toHaveLength(3);
    expect(
      [...context.repository.read().interviews.values()].every(
        (interview) => interview.status === 'proposed'
      )
    ).toBe(true);
  });

  it('books one proposal, cancels siblings, and replays the booked result idempotently', async () => {
    const { seed, application } = interviewSeed();
    const context = createTestContext({ seed, idPrefix: 'p16-booking' });
    const service = new OperationService(context.repository, coordinatorHandlers);
    const proposal = await service.invoke(
      'coordinate_interview_workflow',
      { applicationId: application.id, action: 'propose_slots' },
      context.actor
    );
    const slot = proposal.proposedSlots[1]!.slot;

    const first = await service.invoke(interviewEnvelope(
      { applicationId: application.id, action: 'book_slot', slot },
      'booking-first'
    ));
    const replay = await service.invoke(interviewEnvelope(
      { applicationId: application.id, action: 'book_slot', slot },
      'booking-second'
    ));
    const state = context.repository.read();

    expect(replay).toEqual(first);
    expect(first.bookedInterview?.slot).toBe(slot);
    expect(first.proposedSlots).toEqual([]);
    expect(state.applications.get(application.id)?.status).toBe('interviewing');
    expect(
      [...state.interviews.values()].filter((interview) => interview.status === 'booked')
    ).toHaveLength(1);
    expect(
      [...state.interviews.values()].filter((interview) => interview.status === 'cancelled')
    ).toHaveLength(2);
  });

  it('rejects invalid, stale, and lifecycle-invalid interview actions without domain mutation', async () => {
    const { seed, application } = interviewSeed();
    const context = createTestContext({ seed, idPrefix: 'p16-invalid-interview' });
    const service = new OperationService(context.repository, coordinatorHandlers);

    const staleBefore = domainSnapshot(context.repository.read());
    const staleError = await captureError(
      service.invoke({
        name: 'coordinate_interview_workflow',
        input: { applicationId: application.id, action: 'propose_slots' },
        actor: context.actor,
        metadata: { idempotencyKey: 'stale-proposal', expectedRevision: 99 }
      })
    );
    expect(staleError.details?.reason).toBe('stale_revision');
    expect(domainSnapshot(context.repository.read())).toEqual(staleBefore);

    await service.invoke(
      'coordinate_interview_workflow',
      { applicationId: application.id, action: 'propose_slots' },
      context.actor
    );
    const beforeInvalidBooking = domainSnapshot(context.repository.read());
    const invalidBookingError = await captureError(
      service.invoke(
        'coordinate_interview_workflow',
        {
          applicationId: application.id,
          action: 'book_slot',
          slot: '2026-10-01T10:00:00Z'
        },
        context.actor
      )
    );
    expect(invalidBookingError.status).toBe(409);
    expect(domainSnapshot(context.repository.read())).toEqual(beforeInvalidBooking);

    const lifecycleContext = createTestContext({
      seed: interviewSeed('applied').seed,
      idPrefix: 'p16-lifecycle'
    });
    const lifecycleBefore = domainSnapshot(lifecycleContext.repository.read());
    const lifecycleError = await captureError(
      new OperationService(lifecycleContext.repository, coordinatorHandlers).invoke(
        'coordinate_interview_workflow',
        { applicationId: 'p16-application', action: 'propose_slots' },
        lifecycleContext.actor
      )
    );
    expect(lifecycleError.status).toBe(409);
    expect(domainSnapshot(lifecycleContext.repository.read())).toEqual(lifecycleBefore);
  });

  it('initializes an accepted offer with deterministic tasks and returns the same checklist on a new key', async () => {
    const { seed, application, offer } = onboardingSeed();
    const context = createTestContext({ seed, idPrefix: 'p16-onboarding' });
    const service = new OperationService(context.repository, coordinatorHandlers);
    const input = { offerId: offer.id, action: 'initialize_checklist' } as const;

    const first = await service.invoke(onboardingEnvelope(
      input,
      'checklist-first'
    ));
    const replay = await service.invoke(onboardingEnvelope(
      input,
      'checklist-second'
    ));
    const state = context.repository.read();

    expect(replay).toEqual(first);
    expect(first.changedTasks).toHaveLength(3);
    expect(first.changedTasks.map(({ dueDate }) => dueDate)).toEqual([
      '2026-09-07T09:00:00.000Z',
      '2026-09-10T09:00:00.000Z',
      '2026-09-14T09:00:00.000Z'
    ]);
    expect(first.taskCompletion).toEqual({ done: 0, total: 3 });
    expect(first.completionPercentage).toBe(0);
    expect(state.applications.get(application.id)?.status).toBe('onboarding');
    expect([...state.onboardingTasks.values()]).toHaveLength(3);
  });

  it('enforces explicit task transitions, zero-safe aggregation, and authorized corrections', async () => {
    const { seed, application, offer } = onboardingSeed();
    const context = createTestContext({ seed, idPrefix: 'p16-task' });
    const service = new OperationService(context.repository, coordinatorHandlers);
    const initialized = await service.invoke(
      'coordinate_onboarding_workflow',
      { offerId: offer.id, action: 'initialize_checklist' },
      context.actor
    );
    const taskId = initialized.changedTasks[0]!.taskId;

    const beforeSkipped = domainSnapshot(context.repository.read());
    const skipped = await captureError(
      service.invoke(
        'coordinate_onboarding_workflow',
        { offerId: offer.id, action: 'update_task', taskId, status: 'complete' },
        context.actor
      )
    );
    expect(skipped.status).toBe(409);
    expect(domainSnapshot(context.repository.read())).toEqual(beforeSkipped);

    const inProgress = await service.invoke(
      'coordinate_onboarding_workflow',
      { offerId: offer.id, action: 'update_task', taskId, status: 'in_progress' },
      context.actor
    );
    expect(inProgress.taskCompletion).toEqual({ done: 0, total: 3 });
    const complete = await service.invoke(
      'coordinate_onboarding_workflow',
      { offerId: offer.id, action: 'update_task', taskId, status: 'complete' },
      context.actor
    );
    expect(complete.taskCompletion).toEqual({ done: 1, total: 3 });
    expect(complete.completionPercentage).toBeCloseTo(100 / 3);

    const replay = await service.invoke(onboardingEnvelope(
      { offerId: offer.id, action: 'update_task', taskId, status: 'complete' },
      'task-replay'
    ));
    expect(replay).toEqual(complete);

    const unauthorizedPrincipal = createTrustedPrincipal({
      actor: { actorType: 'human_ui', actorId: 'alice-candidate' },
      role: 'candidate'
    });
    const unauthorizedService = new OperationService({
      repository: context.repository,
      principal: unauthorizedPrincipal,
      handlers: coordinatorHandlers
    });
    const beforeCorrection = domainSnapshot(context.repository.read());
    const denied = await captureError(
      unauthorizedService.invoke({
        name: 'coordinate_onboarding_workflow',
        input: {
          offerId: offer.id,
          action: 'update_task',
          taskId,
          status: 'in_progress'
        },
        actor: unauthorizedPrincipal.actor,
        metadata: { idempotencyKey: 'unauthorized-correction' }
      })
    );
    expect(denied.status).toBe(403);
    expect(domainSnapshot(context.repository.read())).toEqual(beforeCorrection);

    const recruiterPrincipal = createTrustedPrincipal({
      actor: context.actor,
      role: 'recruiter'
    });
    const recruiterService = new OperationService({
      repository: context.repository,
      principal: recruiterPrincipal,
      handlers: coordinatorHandlers
    });
    const corrected = await recruiterService.invoke({
      name: 'coordinate_onboarding_workflow',
      input: {
        offerId: offer.id,
        action: 'update_task',
        taskId,
        status: 'in_progress'
      },
      actor: recruiterPrincipal.actor,
      metadata: { idempotencyKey: 'authorized-correction' }
    });
    expect(corrected.taskCompletion).toEqual({ done: 0, total: 3 });
    expect(context.repository.read().onboardingTasks.get(taskId)?.status).toBe(
      'in_progress'
    );
    expect(context.repository.read().applications.get(application.id)?.status).toBe(
      'onboarding'
    );
  });

  it('rejects unaccepted offers and permission-denied callers before mutation', async () => {
    const { seed, offer } = onboardingSeed('offer_accepted', 'sent');
    const context = createTestContext({ seed, idPrefix: 'p16-guard' });
    const service = new OperationService(context.repository, coordinatorHandlers);
    const before = domainSnapshot(context.repository.read());
    const guardError = await captureError(
      service.invoke(
        'coordinate_onboarding_workflow',
        { offerId: offer.id, action: 'initialize_checklist' },
        context.actor
      )
    );
    expect(guardError.status).toBe(409);
    expect(domainSnapshot(context.repository.read())).toEqual(before);

    const accepted = onboardingSeed();
    const permissionContext = createTestContext({
      seed: accepted.seed,
      idPrefix: 'p16-permission'
    });
    const candidate = createTrustedPrincipal({
      actor: { actorType: 'human_ui', actorId: 'alice-candidate' },
      role: 'candidate',
      resourceScopes: [
        {
          resourceType: 'offer',
          mode: 'self',
          resourceIds: [accepted.offer.id],
          subjectId: 'cand-1'
        }
      ]
    });
    const permissionService = new OperationService({
      repository: permissionContext.repository,
      principal: candidate,
      authorizationPolicy: createAuthorizationPolicy({ environment: 'test' }),
      handlers: coordinatorHandlers
    });
    const permissionBefore = domainSnapshot(permissionContext.repository.read());
    const permissionError = await captureError(
      permissionService.invoke({
        name: 'coordinate_onboarding_workflow',
        input: { offerId: accepted.offer.id, action: 'initialize_checklist' },
        actor: candidate.actor,
        metadata: { idempotencyKey: 'candidate-coordinator' }
      })
    );
    expect([403, 409]).toContain(permissionError.status);
    expect(permissionError.details?.reason).toBeDefined();
    expect(domainSnapshot(permissionContext.repository.read())).toEqual(
      permissionBefore
    );
  });
});
