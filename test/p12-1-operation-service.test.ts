import { describe, expect, it } from 'vitest';
import type { JobRequisition } from '../src/shared/models';
import { ConflictError, PipelineError } from '../src/shared/errors';
import {
  createAuthorizationPolicy,
  createTrustedPrincipal
} from '../src/server/authorization';
import {
  OperationService,
  type OperationHandler
} from '../src/server/operationService';
import { createTestContext } from './factories';

const ACTOR = { actorType: 'human_ui' as const, actorId: 'test-recruiter' };

function envelope<N extends Parameters<OperationService['invoke']>[0]>(
  name: N,
  input: Record<string, unknown>,
  idempotencyKey: string,
  correlationId = 'correlation-test',
  parentSpanId = 'parent-test'
) {
  return {
    name,
    input,
    actor: ACTOR,
    metadata: { idempotencyKey, correlationId, parentSpanId }
  } as never;
}

describe('P12.1 OperationService envelope orchestration', () => {
  it('keeps metadata outside handler input and replays one success without rerunning', async () => {
    const { repository } = createTestContext();
    let calls = 0;
    const handler: OperationHandler<'search_candidates'> = (input) => {
      calls += 1;
      expect(input).toEqual({});
      return { results: [] };
    };
    const service = new OperationService(repository, {
      search_candidates: handler
    });

    const first = await service.invoke(
      envelope('search_candidates', {}, 'same-key', 'correlation-a', 'parent-a')
    );
    const replay = await service.invoke(
      envelope('search_candidates', {}, 'same-key', 'correlation-b', 'parent-b')
    );

    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    const entries = repository.read().activityLog;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      correlationId: 'correlation-a',
      parentSpanId: 'parent-a',
      phase: 'read'
    });
    expect(entries[0].trace?.spans.length).toBeGreaterThanOrEqual(2);
    expect(entries[1]).toMatchObject({
      correlationId: 'correlation-b',
      parentSpanId: 'parent-b',
      phase: 'replay',
      replayed: true,
      originalActivityId: entries[0].id
    });
  });

  it('replays exact errors and rejects changed fingerprints without rerunning', async () => {
    const { repository } = createTestContext();
    let calls = 0;
    const handler: OperationHandler<'search_candidates'> = () => {
      calls += 1;
      throw new ConflictError('deterministic failure', {
        reason: 'entity_changed'
      });
    };
    const service = new OperationService(repository, {
      search_candidates: handler
    });
    const firstInvocation = envelope(
      'search_candidates',
      {},
      'error-key',
      'correlation-a'
    );

    let firstError: PipelineError | undefined;
    try {
      await service.invoke(firstInvocation);
    } catch (error) {
      firstError = PipelineError.from(error);
    }
    let replayError: PipelineError | undefined;
    try {
      await service.invoke(envelope('search_candidates', {}, 'error-key', 'correlation-b'));
    } catch (error) {
      replayError = PipelineError.from(error);
    }

    expect(replayError?.toPayload()).toEqual(firstError?.toPayload());
    expect(calls).toBe(1);

    await expect(
      service.invoke(envelope('search_candidates', { query: 'changed' }, 'error-key'))
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'idempotency_key_reuse' }
    });
    expect(calls).toBe(1);
    expect(repository.read().activityLog.at(-1)).toMatchObject({
      phase: 'read',
      output: { error: { details: { reason: 'idempotency_key_reuse' } } }
    });
  });

  it('checks expected revision before a mutation can change the draft', async () => {
    const { repository } = createTestContext();
    let calls = 0;
    const handler: OperationHandler<'create_job_requisition'> = (_input, context) => {
      calls += 1;
      const job: JobRequisition = {
        id: context.nextId('job'),
        title: 'Should not be created',
        department: 'Engineering',
        requirements: ['TypeScript'],
        compBand: { min: 1, max: 2, currency: 'USD' },
        status: 'open',
        createdBy: context.actor.actorId,
        createdAt: context.now()
      };
      context.state.jobs.set(job.id, job);
      return { jobId: job.id };
    };
    const service = new OperationService(repository, {
      create_job_requisition: handler
    });

    await expect(
      service.invoke({
        name: 'create_job_requisition',
        input: {
          title: 'Stale',
          department: 'Engineering',
          requirements: ['TypeScript'],
          compBand: { min: 1, max: 2, currency: 'USD' }
        },
        actor: ACTOR,
        metadata: { expectedRevision: 9, idempotencyKey: 'stale-key' }
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'stale_revision', expectedRevision: 9, currentRevision: 0 }
    });
    expect(calls).toBe(0);
    expect(repository.read().jobs.has('Should not be created')).toBe(false);
  });

  it('plans against a preview draft, approves, and commits with real IDs', async () => {
    const { repository } = createTestContext();
    const targetHandler: OperationHandler<'coordinate_interview_workflow'> = (
      input,
      context
    ) => {
      const job = context.state.jobs.get('job-1')!;
      const jobId = context.nextId('job');
      context.state.jobs.set(jobId, { ...job, id: jobId, title: 'Preview/committed role' });
      return {
        applicationId: input.applicationId,
        stage: context.preview ? 'preview' : 'committed',
        proposedSlots: [],
        bookedInterview: null,
        nextAction: null,
        blockers: []
      };
    };
    const service = new OperationService(repository, {
      coordinate_interview_workflow: targetHandler
    });

    const plan = await service.invoke({
      name: 'plan_operation',
      input: {
        targetOperation: 'coordinate_interview_workflow',
        input: { applicationId: 'app-1', action: 'propose_slots' }
      },
      actor: ACTOR,
      metadata: { idempotencyKey: 'plan-key', correlationId: 'plan-correlation' }
    });

    expect(plan.status).toBe('pending');
    expect(plan.redactions).toEqual(expect.any(Array));
    expect(repository.read().jobs.has('preview-job-1')).toBe(false);
    expect(repository.read().approvalCards.size).toBe(1);
    const cardId = plan.approvalId;
    const card = repository.read().approvalCards.get(cardId)!;
    expect(card.affectedRecords[0]?.id).toBe('preview-job-1');

    const approved = await service.invoke({
      name: 'approve_operation_plan',
      input: { approvalId: cardId },
      actor: ACTOR,
      metadata: { idempotencyKey: 'approve-key' }
    });
    expect(approved.status).toBe('approved');

    const committed = await service.invoke({
      name: 'commit_operation_plan',
      input: { approvalId: cardId },
      actor: ACTOR,
      metadata: { idempotencyKey: 'commit-key' }
    });
    expect(committed.status).toBe('committed');
    expect(repository.read().approvalCards.get(cardId)?.status).toBe('committed');
    expect([...repository.read().jobs.keys()].some((id) => id.startsWith('preview-'))).toBe(false);
    expect([...repository.read().jobs.keys()].some((id) => id !== 'job-1')).toBe(true);
  });

  it('applies policy capability and resource-scope decisions at execution time', async () => {
    const { repository } = createTestContext();
    let calls = 0;
    const principal = createTrustedPrincipal({
      actor: { actorType: 'human_ui', actorId: 'alice-candidate' },
      role: 'candidate',
      resourceScopes: [
        {
          resourceType: 'candidate',
          mode: 'self',
          resourceIds: ['cand-1'],
          subjectId: 'cand-1'
        }
      ]
    });
    const service = new OperationService({
      repository,
      principal,
      authorizationPolicy: createAuthorizationPolicy({ environment: 'test' }),
      handlers: {
        get_candidate_profile: () => {
          calls += 1;
          return {
            id: 'cand-2',
            name: 'hidden',
            email: 'hidden@example.test',
            resumeText: 'hidden',
            skills: [],
            experienceYears: 1,
            resumeTextHistory: [],
            applicationHistory: []
          };
        }
      }
    });

    await expect(
      service.invoke({
        name: 'get_candidate_profile',
        input: { candidateId: 'cand-2' },
        actor: principal.actor,
        metadata: { idempotencyKey: 'forbidden-key' }
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_ERROR',
      details: { reason: 'resource_scope' }
    });
    expect(calls).toBe(0);
  });
});
