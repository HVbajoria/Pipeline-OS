import { describe, expect, it } from 'vitest';
import type {
  ActorContext,
  SharedStateWithCatalogs
} from '../src/shared/models';
import type {
  ImportPublicProspectInput,
  PlanOperationInput
} from '../src/shared/operations';
import { PipelineError } from '../src/shared/errors';
import {
  OperationService
} from '../src/server/operationService';
import {
  defaultOperationAdapters,
  defaultOperationHandlers
} from '../src/server/operations';
import {
  PUBLIC_PROSPECT_RETENTION_DAYS
} from '../src/server/operations/importPublicProspect';
import {
  createTestContext,
  TEST_TIMESTAMP
} from './factories';

const ACTOR: ActorContext = {
  actorType: 'human_ui',
  actorId: 'sarah-recruiter'
};
const PRIVATE_EMAIL = 'candidate.private@example.test';
const PRIVATE_RESUME = 'candidate private resume marker';

function sourceInput(): ImportPublicProspectInput {
  return {
    source: 'github',
    sourceRecordId: 'public-user-1',
    profileUrl: 'https://github.com/public-user-1',
    canonicalSourceUrl: 'https://api.github.com/users/public-user-1',
    sourceQuery: 'backend engineer',
    sourceFilters: { language: 'TypeScript', location: 'Berlin' },
    fetchedAt: TEST_TIMESTAMP,
    attribution: {
      source: 'github',
      apiUrl: 'https://api.github.com/search/users',
      searchApiDocsUrl: 'https://docs.github.com/en/rest/search/search',
      rateLimitsDocsUrl:
        'https://docs.github.com/en/rest/using-the-rest-api/rate-limits',
      userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
    },
    consent: {
      method: 'approved_consent_channel',
      scope: 'candidate-profile-import',
      capturedAt: TEST_TIMESTAMP,
      capturedBy: ACTOR,
      evidenceRef: 'consent-record-1',
      policyVersion: 'p14.test.v1'
    }
  };
}

function candidateInput(): ImportPublicProspectInput {
  return {
    ...sourceInput(),
    consent: {
      ...sourceInput().consent,
      method: 'candidate_submitted'
    },
    candidateProfile: {
      name: 'Candidate Submitted',
      email: PRIVATE_EMAIL,
      resumeText: PRIVATE_RESUME,
      skills: ['TypeScript', 'Node.js'],
      experienceYears: 6
    }
  };
}

function serviceFor(
  context: ReturnType<typeof createTestContext>,
  withApprovalAdapters = false
): OperationService {
  return new OperationService({
    repository: context.repository,
    handlers: defaultOperationHandlers,
    ...(withApprovalAdapters
      ? { orchestrationAdapters: defaultOperationAdapters }
      : {})
  });
}

function domainCollections(state: SharedStateWithCatalogs) {
  return {
    jobs: [...state.jobs.entries()],
    candidates: [...state.candidates.entries()],
    applications: [...state.applications.entries()],
    panels: [...state.panels.entries()],
    interviews: [...state.interviews.entries()],
    scorecards: [...state.scorecards.entries()],
    offers: [...state.offers.entries()],
    onboardingTasks: [...state.onboardingTasks.entries()],
    backgroundChecks: [...state.backgroundChecks.entries()],
    benefitsEnrollments: [...state.benefitsEnrollments.entries()],
    sourcedProspects: [...state.sourcedProspects.entries()]
  };
}

describe('public prospect import and consent revocation handlers', () => {
  it('registers both canonical handlers and imports an approved source without candidate synthesis', async () => {
    expect(defaultOperationHandlers.import_public_prospect).toBeTypeOf('function');
    expect(defaultOperationHandlers.revoke_public_prospect_consent).toBeTypeOf(
      'function'
    );

    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const before = context.repository.read();

    const output = await service.invoke(
      'import_public_prospect',
      sourceInput(),
      ACTOR
    );
    const after = context.repository.read();
    const sourced = after.sourcedProspects.get(output.sourcedProspect.id);

    expect(output.status).toBe('imported');
    expect(output.candidateId).toBeUndefined();
    expect(sourced).toMatchObject({
      source: 'github',
      sourceRecordId: 'public-user-1',
      dataOrigin: 'public_github',
      consentStatus: 'explicit',
      consent: sourceInput().consent
    });
    expect(sourced?.retentionExpiresAt).toBe('2026-01-31T00:00:00.000Z');
    expect(sourced?.fieldOrigins).toEqual(
      expect.objectContaining({
        sourceRecordId: 'github_public',
        profileUrl: 'github_public',
        consent: 'recruiter_entered'
      })
    );
    expect(domainCollections(after).candidates).toEqual(
      domainCollections(before).candidates
    );
    expect(after.applications).toHaveLength(0);
    expect(after.sourcedProspects).toHaveLength(1);
  });

  it('creates or links a candidate only from submitted fields and redacts private values from activity', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);

    const output = await service.invoke(
      'import_public_prospect',
      candidateInput(),
      ACTOR
    );
    const state = context.repository.read();
    const candidate = state.candidates.get(output.candidateId!);
    const sourced = state.sourcedProspects.get(output.sourcedProspect.id);

    expect(output.status).toBe('linked');
    expect(candidate).toEqual({
      id: output.candidateId,
      name: 'Candidate Submitted',
      email: PRIVATE_EMAIL,
      resumeText: PRIVATE_RESUME,
      skills: ['TypeScript', 'Node.js'],
      experienceYears: 6,
      resumeTextHistory: []
    });
    expect(sourced).toBeDefined();
    expect(sourced).not.toHaveProperty('name');
    expect(sourced).not.toHaveProperty('email');
    expect(sourced).not.toHaveProperty('resumeText');
    expect(sourced?.candidateId).toBe(output.candidateId);
    expect(sourced?.fieldOrigins).toEqual(
      expect.objectContaining({
        name: 'candidate_submitted',
        email: 'candidate_submitted',
        resumeText: 'candidate_submitted'
      })
    );
    expect(state.applications).toHaveLength(0);
    expect(JSON.stringify(state.activityLog)).not.toContain(PRIVATE_EMAIL);
    expect(JSON.stringify(state.activityLog)).not.toContain(PRIVATE_RESUME);
  });

  it('rejects candidate profile fields unless the consent method is candidate-submitted', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const before = context.repository.read();

    await expect(
      service.invoke(
        'import_public_prospect',
        {
          ...candidateInput(),
          consent: {
            ...sourceInput().consent,
            method: 'approved_consent_channel'
          }
        },
        ACTOR
      )
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'candidateProfile', reason: 'consent_invalid' }
    });

    const after = context.repository.read();
    expect(domainCollections(after)).toEqual(domainCollections(before));
    expect(after.activityLog).toHaveLength(1);
    expect(JSON.stringify(after.activityLog)).not.toContain(PRIVATE_EMAIL);
    expect(JSON.stringify(after.activityLog)).not.toContain(PRIVATE_RESUME);
  });

  it('does not mutate domain state for invalid consent or non-allowlisted source references', async () => {
    const invalidConsentContext = createTestContext({ timestamp: TEST_TIMESTAMP });
    const invalidConsentService = serviceFor(invalidConsentContext);
    const beforeConsent = invalidConsentContext.repository.read();

    await expect(
      invalidConsentService.invoke(
        'import_public_prospect',
        {
          ...sourceInput(),
          consent: {
            ...sourceInput().consent,
            capturedAt: '2026-01-02T00:00:00.000Z'
          }
        },
        ACTOR
      )
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'consent_invalid' }
    });

    expect(domainCollections(invalidConsentContext.repository.read())).toEqual(
      domainCollections(beforeConsent)
    );

    const invalidSourceContext = createTestContext({ timestamp: TEST_TIMESTAMP });
    const invalidSourceService = serviceFor(invalidSourceContext);
    const beforeSource = invalidSourceContext.repository.read();
    await expect(
      invalidSourceService.invoke(
        'import_public_prospect',
        {
          ...sourceInput(),
          profileUrl: 'https://evil.example.test/public-user-1'
        },
        ACTOR
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(domainCollections(invalidSourceContext.repository.read())).toEqual(
      domainCollections(beforeSource)
    );
  });

  it('deduplicates an approved import and never creates a second candidate', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const input = candidateInput();

    const first = await service.invoke('import_public_prospect', input, ACTOR);
    const second = await service.invoke('import_public_prospect', input, ACTOR);
    const state = context.repository.read();

    expect(second).toEqual(first);
    expect(state.sourcedProspects).toHaveLength(1);
    expect(state.candidates).toHaveLength(4);
    expect(state.applications).toHaveLength(0);
  });

  it('supports an approved plan/commit without mutating the preview and creates one source record', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context, true);
    const targetInput = sourceInput() as unknown as PlanOperationInput['input'];
    const beforePlan = context.repository.read();

    const plan = await service.invoke({
      name: 'plan_operation',
      input: {
        targetOperation: 'import_public_prospect',
        input: targetInput
      },
      actor: ACTOR,
      metadata: { idempotencyKey: 'plan-import-1' }
    });

    expect(context.repository.read().sourcedProspects).toHaveLength(0);
    expect(context.repository.read().candidates).toEqual(beforePlan.candidates);
    expect(plan.proposedOutput).toMatchObject({
      sourcedProspect: {
        consentStatus: 'explicit',
        dataOrigin: 'public_github'
      },
      status: 'imported'
    });

    await service.invoke({
      name: 'approve_operation_plan',
      input: { approvalId: plan.approvalId },
      actor: ACTOR,
      metadata: {
        idempotencyKey: 'approve-import-1',
        approvalId: plan.approvalId
      }
    });
    const committed = await service.invoke({
      name: 'commit_operation_plan',
      input: { approvalId: plan.approvalId },
      actor: ACTOR,
      metadata: {
        idempotencyKey: 'commit-import-1',
        approvalId: plan.approvalId
      }
    });

    expect(committed.status).toBe('committed');
    expect(context.repository.read().sourcedProspects).toHaveLength(1);
    expect(context.repository.read().candidates).toEqual(beforePlan.candidates);
  });

  it('withdraws consent idempotently, preserves the safe marker, and blocks reuse', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const imported = await service.invoke(
      'import_public_prospect',
      sourceInput(),
      ACTOR
    );
    const revoked = await service.invoke(
      'revoke_public_prospect_consent',
      { sourcedProspectId: imported.sourcedProspect.id, reason: 'candidate request' },
      ACTOR
    );
    const afterFirst = context.repository.read();

    expect(revoked).toMatchObject({
      sourcedProspectId: imported.sourcedProspect.id,
      status: 'withdrawn',
      retentionAction: expect.stringContaining('future public-prospect use is blocked')
    });
    expect(afterFirst.sourcedProspects.get(imported.sourcedProspect.id)?.consentStatus).toBe(
      'withdrawn'
    );

    const repeated = await service.invoke(
      'revoke_public_prospect_consent',
      { sourcedProspectId: imported.sourcedProspect.id },
      ACTOR
    );
    expect(repeated).toEqual(revoked);
    expect(context.repository.read().sourcedProspects).toEqual(
      afterFirst.sourcedProspects
    );

    await expect(
      service.invoke('import_public_prospect', sourceInput(), ACTOR)
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'already_withdrawn' }
    });
    await expect(
      service.invoke(
        'import_public_prospect',
        {
          ...sourceInput(),
          consent: {
            ...sourceInput().consent,
            evidenceRef: 'consent-record-2'
          }
        },
        ACTOR
      )
    ).rejects.toMatchObject({
      code: 'CONFLICT_ERROR',
      details: { reason: 'already_withdrawn' }
    });
    expect(context.repository.read().sourcedProspects).toHaveLength(1);
  });

  it('returns a safe not-found error without changing domain collections', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const before = context.repository.read();

    await expect(
      service.invoke(
        'revoke_public_prospect_consent',
        { sourcedProspectId: 'missing-prospect' },
        ACTOR
      )
    ).rejects.toMatchObject({
      code: 'NOT_FOUND_ERROR',
      details: { reason: 'record_not_found' }
    });
    expect(domainCollections(context.repository.read())).toEqual(
      domainCollections(before)
    );
  });

  it('uses the configured retention period and keeps the source projection free of private profile data', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    const output = await service.invoke(
      'import_public_prospect',
      candidateInput(),
      ACTOR
    );

    const expectedExpiry = new Date(
      Date.parse(TEST_TIMESTAMP) + PUBLIC_PROSPECT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    expect(output.sourcedProspect.retentionExpiresAt).toBe(expectedExpiry);
    expect(JSON.stringify(output.sourcedProspect)).not.toContain(PRIVATE_EMAIL);
    expect(JSON.stringify(output.sourcedProspect)).not.toContain(PRIVATE_RESUME);
  });

  it('keeps PipelineError details stable for invalid imports', async () => {
    const context = createTestContext({ timestamp: TEST_TIMESTAMP });
    const service = serviceFor(context);
    try {
      await service.invoke(
        'import_public_prospect',
        {
          ...sourceInput(),
          consent: {
            ...sourceInput().consent,
            capturedAt: '2026-02-01T00:00:00.000Z'
          }
        },
        ACTOR
      );
      throw new Error('expected import to fail');
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      expect(pipelineError.code).toBe('VALIDATION_ERROR');
      expect(pipelineError.details?.reason).toBe('consent_invalid');
      expect(JSON.stringify(pipelineError.toPayload())).not.toContain(
        PRIVATE_EMAIL
      );
    }
  });
});
