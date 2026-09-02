import { compareCandidates } from '../src/shared/domain/comparison';
import {
  calculateRecruitingWorkflowStatus
} from '../src/shared/domain/workflowStatus';
import type {
  ApprovalCardRecord,
  ApplicationRecord,
  JobRequisition,
  OfferRecord
} from '../src/shared/models';
import {
  createAuthorizationPolicy,
  createTrustedPrincipal
} from '../src/server/authorization';
import { OperationService } from '../src/server/operationService';
import { defaultOperationHandlers } from '../src/server/operations';
import { createSeededRepository } from './factories';

const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const RECRUITER = { actorType: 'human_ui' as const, actorId: 'sarah-recruiter' };

function application(
  id: string,
  candidateId: string,
  status: ApplicationRecord['status'] = 'applied'
): ApplicationRecord {
  return {
    id,
    candidateId,
    jobId: 'job-1',
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: FIXED_NOW
  };
}

describe('P13 comparison and workflow status domains', () => {
  it('uses explicit weights, stable ID tie breaks, and safe evidence', () => {
    const job: Pick<JobRequisition, 'requirements'> = {
      requirements: ['TypeScript']
    };
    const candidates = [
      {
        id: 'cand-b',
        name: 'Candidate B',
        skills: ['TypeScript'],
        experienceYears: 5
      },
      {
        id: 'cand-a',
        name: 'Candidate A',
        skills: ['TypeScript'],
        experienceYears: 5
      }
    ];

    const result = compareCandidates(job, candidates);

    expect(result.map(({ candidateId, rank }) => ({ candidateId, rank }))).toEqual([
      { candidateId: 'cand-a', rank: 1 },
      { candidateId: 'cand-b', rank: 2 }
    ]);
    expect(result[0]).toMatchObject({
      totalScore: 90,
      scoreBreakdown: {
        requirementMatch: { matched: ['TypeScript'], missing: [], score: 100 },
        skillOverlap: { matched: ['typescript'], score: 100 },
        experienceFit: { score: 50 }
      }
    });
    expect(result[0]?.rationale).toContain('Candidate reports 5 years');
    expect(JSON.stringify(result)).not.toContain('resume');
  });

  it('returns the snapshot revision and does not mutate domain collections during comparison', async () => {
    const repository = createSeededRepository();
    const principal = createTrustedPrincipal({
      actor: RECRUITER,
      role: 'recruiter',
      resourceScopes: [
        { resourceType: 'job', mode: 'assigned', resourceIds: ['job-1'] },
        {
          resourceType: 'candidate',
          mode: 'assigned',
          resourceIds: ['cand-1', 'cand-2', 'cand-3']
        }
      ]
    });
    const service = new OperationService({
      repository,
      handlers: defaultOperationHandlers,
      principal,
      authorizationPolicy: createAuthorizationPolicy({ environment: 'test' })
    });
    const before = repository.read();
    const output = await service.invoke(
      'compare_candidates',
      { jobId: 'job-1', candidateIds: ['cand-1', 'cand-2'] },
      RECRUITER
    );

    expect(output.revision).toBe(before.revision);
    expect(output.candidates).toHaveLength(2);
    expect([...repository.read().jobs.entries()]).toEqual([...before.jobs.entries()]);
    expect([...repository.read().candidates.entries()]).toEqual([
      ...before.candidates.entries()
    ]);
  });

  it('reports accepted-offer prerequisites without inventing onboarding progress', () => {
    const repository = createSeededRepository();
    repository.transact((draft) => {
      draft.applications.set('app-accepted', application('app-accepted', 'cand-1', 'offer_accepted'));
      const offer: OfferRecord = {
        id: 'offer-accepted',
        applicationId: 'app-accepted',
        compAmount: 170000,
        currency: 'USD',
        status: 'accepted',
        counterAmount: null,
        sentAt: FIXED_NOW,
        respondedAt: FIXED_NOW
      };
      draft.offers.set(offer.id, offer);
    });

    const snapshot = repository.read();
    const output = calculateRecruitingWorkflowStatus(
      snapshot,
      { applicationId: 'app-accepted', detail: 'full' },
      { generatedAt: FIXED_NOW }
    );

    expect(output.revision).toBe(snapshot.revision);
    expect(output.countsByApplicationStatus.offer_accepted).toBe(1);
    expect(output.applications[0]).toMatchObject({
      currentStage: 'onboarding',
      blockers: ['Offer accepted but checklist not generated.'],
      nextActions: ['Generate the onboarding checklist.']
    });
  });

  it('filters status rows by trusted candidate scope and denies another application', async () => {
    const repository = createSeededRepository();
    repository.transact((draft) => {
      draft.applications.set('app-own', application('app-own', 'cand-1'));
      draft.applications.set('app-other', application('app-other', 'cand-2'));
    });
    const principal = createTrustedPrincipal({
      actor: { actorType: 'human_ui', actorId: 'alice-candidate' },
      role: 'candidate',
      resourceScopes: [
        {
          resourceType: 'candidate',
          mode: 'self',
          resourceIds: ['cand-1'],
          subjectId: 'cand-1'
        },
        { resourceType: 'application', mode: 'self', subjectId: 'cand-1' }
      ]
    });
    const actor = principal.actor;
    const service = new OperationService({
      repository,
      handlers: defaultOperationHandlers,
      principal,
      authorizationPolicy: createAuthorizationPolicy({ environment: 'test' })
    });

    const output = await service.invoke(
      'get_recruiting_workflow_status',
      {},
      actor
    );
    expect(output.applications.map(({ applicationId }) => applicationId)).toEqual(['app-own']);
    expect(output.countsByApplicationStatus.applied).toBe(1);

    await expect(
      service.invoke(
        'get_recruiting_workflow_status',
        { applicationId: 'app-other' },
        actor
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ERROR', details: { reason: 'resource_scope' } });
  });

  it('redacts protected approval payload fields in workflow status', () => {
    const repository = createSeededRepository();
    repository.transact((draft) => {
      const card: ApprovalCardRecord = {
        id: 'approval-status-1',
        targetOperation: 'coordinate_interview_workflow',
        normalizedInput: { applicationId: 'app-1', email: 'private@example.com' },
        requestFingerprint: 'private-fingerprint',
        requestedBy: RECRUITER,
        requestedAt: FIXED_NOW,
        baseRevision: draft.revision,
        targetFingerprint: 'private-target-fingerprint',
        affectedRecords: [],
        proposedOutput: { email: 'private@example.com', safe: 'visible' },
        changeSummary: ['Review workflow'],
        warnings: [],
        requiredCapability: 'interview.coordinate',
        approvalPolicy: 'human',
        status: 'pending',
        expiresAt: '2026-02-01T00:00:00.000Z',
        correlationId: 'correlation-status',
        traceId: 'trace-status'
      };
      draft.approvalCards.set(card.id, card);
    });

    const output = calculateRecruitingWorkflowStatus(repository.read(), {}, {
      generatedAt: FIXED_NOW
    });
    expect(output.pendingApprovals).toHaveLength(1);
    expect(output.pendingApprovals[0]?.proposedOutput).toEqual({ safe: 'visible' });
    expect(JSON.stringify(output.pendingApprovals)).not.toContain('private@example.com');
    expect(JSON.stringify(output.pendingApprovals)).not.toContain('fingerprint');
  });
});
