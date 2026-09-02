import { describe, expect, it } from 'vitest';
import {
  createAuthorizationPolicy,
  createTrustedPrincipal,
  type TrustedPrincipal
} from '../src/server/authorization';
import {
  OperationService,
  type OperationHandler,
  type OperationServiceOptions
} from '../src/server/operationService';
import { approvalOperationAdapters } from '../src/server/operations';
import type { Timestamp } from '../src/shared/models';
import { type Clock, SharedStateRepository } from '../src/server/repository';
import { createTestContext, TEST_TIMESTAMP } from './factories';

const ACTOR = { actorType: 'human_ui' as const, actorId: 'test-recruiter' };

function createTargetHandler(calls: { count: number }): OperationHandler<'coordinate_interview_workflow'> {
  return (input, context) => {
    calls.count += 1;
    return {
      applicationId: input.applicationId,
      stage: context.preview ? 'preview' : 'committed',
      proposedSlots: [],
      bookedInterview: null,
      nextAction: null,
      blockers: ['manual review required']
    };
  };
}

function serviceFor(
  repository: SharedStateRepository,
  calls: { count: number },
  options: Pick<OperationServiceOptions, 'authorizationPolicy' | 'principalResolver' | 'approvalTtlMs'> = {}
): OperationService {
  return new OperationService({
    repository,
    handlers: {
      coordinate_interview_workflow: createTargetHandler(calls)
    },
    orchestrationAdapters: approvalOperationAdapters,
    ...options
  });
}

async function plan(service: OperationService, key = 'plan-key') {
  return service.invoke({
    name: 'plan_operation',
    input: {
      targetOperation: 'coordinate_interview_workflow',
      input: { applicationId: 'app-1', action: 'propose_slots' }
    },
    actor: ACTOR,
    metadata: { idempotencyKey: key }
  });
}

async function approve(service: OperationService, approvalId: string, key = 'approve-key') {
  return service.invoke({
    name: 'approve_operation_plan',
    input: { approvalId },
    actor: ACTOR,
    metadata: { idempotencyKey: key }
  });
}

describe('P12.3 approval-card operations', () => {
  it('propagates blockers, records rejection notes, and prevents rejected commit', async () => {
    const { repository } = createTestContext();
    const calls = { count: 0 };
    const service = serviceFor(repository, calls);
    const planned = await plan(service);

    expect(planned.blockers).toEqual(['manual review required']);
    const card = await service.invoke({
      name: 'get_approval_card',
      input: { approvalId: planned.approvalId },
      actor: ACTOR
    });
    expect(card.blockers).toEqual(['manual review required']);

    const rejected = await service.invoke({
      name: 'reject_operation_plan',
      input: { approvalId: planned.approvalId, note: 'Needs more evidence' },
      actor: ACTOR,
      metadata: { idempotencyKey: 'reject-key' }
    });
    expect(rejected).toMatchObject({
      approvalId: planned.approvalId,
      status: 'rejected',
      note: 'Needs more evidence'
    });
    expect(repository.read().approvalCards.get(planned.approvalId)).toMatchObject({
      status: 'rejected',
      rejectionNote: 'Needs more evidence'
    });

    await expect(
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: planned.approvalId },
        actor: ACTOR,
        metadata: { idempotencyKey: 'commit-rejected-key' }
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'approval_rejected' }
    });
    expect(calls.count).toBe(1);
  });

  it('materializes expiry for pending cards and rejects later approval', async () => {
    const clock = new MutableClock();
    const { repository } = createTestContext({ clock });
    const calls = { count: 0 };
    const service = serviceFor(repository, calls, { approvalTtlMs: 1_000 });
    const planned = await plan(service, 'expiry-plan-key');

    clock.timestamp = planned.expiresAt;
    const expired = await service.invoke({
      name: 'get_approval_card',
      input: { approvalId: planned.approvalId },
      actor: ACTOR
    });
    expect(expired.status).toBe('expired');
    expect(repository.read().approvalCards.get(planned.approvalId)?.status).toBe('expired');

    await expect(approve(service, planned.approvalId, 'expiry-approve-key')).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'plan_expired' }
    });
    expect(calls.count).toBe(1);
  });

  it('terminalizes a stale card inside commit and never reruns it with a new key', async () => {
    const { repository } = createTestContext();
    const calls = { count: 0 };
    const service = serviceFor(repository, calls);
    const planned = await plan(service, 'stale-plan-key');
    await approve(service, planned.approvalId, 'stale-approve-key');

    repository.transact((draft) => {
      draft.jobs.get('job-1')!.status = 'paused';
    });

    await expect(
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: planned.approvalId },
        actor: ACTOR,
        metadata: { idempotencyKey: 'stale-commit-key' }
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'entity_changed' }
    });
    expect(repository.read().approvalCards.get(planned.approvalId)?.status).toBe('expired');
    expect(calls.count).toBe(1);

    await expect(
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: planned.approvalId },
        actor: ACTOR,
        metadata: { idempotencyKey: 'stale-commit-new-key' }
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'plan_expired' }
    });
    expect(calls.count).toBe(1);
  });

  it('terminalizes a card when the trusted policy version changes before commit', async () => {
    let policyVersion = 'policy-a';
    const principalFor = (): TrustedPrincipal =>
      createTrustedPrincipal({
        actor: ACTOR,
        role: 'admin',
        approvalCapabilities: [
          'workflow.approval.approve',
          'workflow.approval.reject',
          'workflow.plan.commit'
        ],
        policyVersion
      });
    const { repository } = createTestContext();
    const calls = { count: 0 };
    const service = serviceFor(repository, calls, {
      authorizationPolicy: createAuthorizationPolicy({ environment: 'test' }),
      principalResolver: () => principalFor()
    });

    const planned = await plan(service, 'policy-plan-key');
    await approve(service, planned.approvalId, 'policy-approve-key');
    policyVersion = 'policy-b';

    await expect(
      service.invoke({
        name: 'commit_operation_plan',
        input: { approvalId: planned.approvalId },
        actor: ACTOR,
        metadata: { idempotencyKey: 'policy-commit-key' }
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'entity_changed' }
    });
    expect(repository.read().approvalCards.get(planned.approvalId)?.status).toBe('expired');
    expect(calls.count).toBe(1);
  });

  it('rejects mismatched metadata and input approval IDs before card execution', async () => {
    const { repository } = createTestContext();
    const calls = { count: 0 };
    const service = serviceFor(repository, calls);

    await expect(
      service.invoke({
        name: 'approve_operation_plan',
        input: { approvalId: 'approval-a' },
        actor: ACTOR,
        metadata: {
          approvalId: 'approval-b',
          idempotencyKey: 'mismatch-key'
        }
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'metadata_invalid', field: 'metadata.approvalId' }
    });
    expect(repository.read().approvalCards.size).toBe(0);
    expect(calls.count).toBe(0);
  });
});

class MutableClock implements Clock {
  timestamp: Timestamp = TEST_TIMESTAMP;

  now(): Timestamp {
    return this.timestamp;
  }
}
