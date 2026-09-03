import { describe, expect, it } from 'vitest';
import type {
  ActivityLogEntry,
  ApprovalCardRecord,
  LegacySharedState,
  SourcedProspectRecord,
  SharedStateProjectionWithCatalogs
} from '../src/shared/models';
import { serializeSharedState } from '../src/server/api';
import {
  InMemoryInvocationLedger,
  SharedStateRepository,
  type InvocationLedgerEntry
} from '../src/server/repository';
import { createSeed, createSeedCatalogs, createSeedState } from '../src/server/seed';
import { useStore } from '../src/lib/store';

const TEST_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function approvalCard(id = 'approval-1'): ApprovalCardRecord {
  return {
    id,
    targetOperation: 'import_public_prospect',
    normalizedInput: {
      sourceRecordId: 'octocat',
      resumeText: 'private normalized resume',
      idempotencyKey: 'idempotency-secret'
    },
    requestFingerprint: 'request-fingerprint-secret',
    requestedBy: { actorType: 'agent', actorId: 'agent-demo' },
    requestedAt: TEST_TIMESTAMP,
    baseRevision: 0,
    targetFingerprint: 'target-fingerprint-secret',
    affectedRecords: [{ type: 'Sourced_Prospect', id: 'prospect-1', effect: 'create' }],
    proposedOutput: {
      sourcedProspectId: 'prospect-1',
      normalizedInput: { resumeText: 'private nested input' },
      requestFingerprint: 'nested fingerprint secret',
      status: 'pending'
    },
    changeSummary: ['Create a provenance record for the public profile'],
    warnings: ['Human approval required'],
    requiredCapability: 'prospect.import',
    approvalPolicy: 'consent_and_human',
    status: 'pending',
    expiresAt: '2026-01-02T00:00:00.000Z',
    correlationId: 'correlation-1',
    traceId: 'trace-1'
  };
}

function sourcedProspect(
  id = 'prospect-1'
): SourcedProspectRecord {
  return {
    id,
    source: 'github',
    sourceRecordId: 'octocat',
    profileUrl: 'https://github.com/octocat',
    canonicalSourceUrl: 'https://api.github.com/users/octocat',
    sourceQuery: 'backend language:TypeScript',
    sourceFilters: { language: 'TypeScript', location: 'Berlin' },
    fetchedAt: TEST_TIMESTAMP,
    importedAt: TEST_TIMESTAMP,
    dataOrigin: 'public_github',
    consentStatus: 'explicit',
    consent: {
      method: 'approved_consent_channel',
      scope: 'candidate profile import',
      capturedAt: TEST_TIMESTAMP,
      capturedBy: { actorType: 'human_ui', actorId: 'sarah-recruiter' },
      evidenceRef: 'consent-evidence-ref-1',
      policyVersion: 'p11.2.v2'
    },
    fieldOrigins: {
      sourceRecordId: 'github_public',
      name: 'candidate_submitted'
    },
    attribution: {
      source: 'github',
      apiUrl: 'https://api.github.com',
      searchApiDocsUrl: 'https://docs.github.com/rest/search',
      rateLimitsDocsUrl: 'https://docs.github.com/rest/using-the-rest-api/rate-limits',
      userApiDocsUrl: 'https://docs.github.com/rest/users/users'
    },
    retentionExpiresAt: '2026-02-01T00:00:00.000Z',
    candidateId: 'cand-1'
  };
}

function activityEntry(): ActivityLogEntry {
  return {
    id: 'activity-1',
    toolName: 'plan_operation',
    actorType: 'agent',
    actorId: 'agent-demo',
    input: {
      safeTarget: 'import_public_prospect',
      normalizedInput: { email: 'private@example.com' },
      rawConsentEvidence: 'do not retain this value',
      idempotencyKey: 'idempotency-secret',
      requestFingerprint: 'request-fingerprint-secret',
      nested: { targetFingerprint: 'target-fingerprint-secret' }
    },
    output: {
      approvalId: 'approval-1',
      consentEvidence: 'private evidence',
      safe: true
    },
    timestamp: TEST_TIMESTAMP,
    trace: {
      spans: [
        {
          spanId: 'span-1',
          name: 'plan',
          status: 'completed',
          startedAt: TEST_TIMESTAMP,
          summary: { requestFingerprint: 'trace fingerprint', safeCount: 1 }
        }
      ]
    }
  };
}

function legacyState(): LegacySharedState {
  const state = createSeedState();
  const {
    approvalCards: _approvalCards,
    sourcedProspects: _sourcedProspects,
    ...legacy
  } = state;
  return legacy as LegacySharedState;
}

function ledgerEntry(): InvocationLedgerEntry {
  return {
    scopeHash: 'scope-hash-secret',
    requestFingerprint: 'request-fingerprint-secret',
    operationName: 'plan_operation',
    status: 'success',
    responseOrError: { approvalId: 'approval-1' },
    originalActivityId: 'activity-1',
    originalRevision: 1,
    correlationId: 'correlation-1',
    traceId: 'trace-1',
    createdAt: TEST_TIMESTAMP,
    expiresAt: '2026-02-01T00:00:00.000Z'
  };
}

describe('P11.3 approval/provenance state and safe projection', () => {
  it('seeds fresh atomic collections and normalizes pre-feature state to empty maps', () => {
    const first = createSeed();
    const second = createSeed();

    expect(first).toEqual(second);
    expect(first.approvalCards).toEqual(new Map());
    expect(first.sourcedProspects).toEqual(new Map());

    const repository = new SharedStateRepository(legacyState());
    const normalized = repository.read();
    expect(normalized.approvalCards).toEqual(new Map());
    expect(normalized.sourcedProspects).toEqual(new Map());
    expect(normalized.catalogs.startDate).toBe(createSeedCatalogs().startDate);
  });

  it('commits approval/provenance records atomically and preserves rollback/reset revisions', () => {
    const ledger = new InMemoryInvocationLedger();
    const repository = new SharedStateRepository(createSeed(), { ledger });
    const card = approvalCard();
    const prospect = sourcedProspect();
    const activity = activityEntry();

    repository.transact((draft) => {
      draft.approvalCards.set(card.id, card);
      draft.sourcedProspects.set(prospect.id, prospect);
    }, activity);

    expect(repository.getRevision()).toBe(1);
    expect(repository.read().approvalCards.get(card.id)).toEqual(card);
    expect(repository.read().sourcedProspects.get(prospect.id)).toEqual(prospect);
    expect(repository.read().activityLog).toEqual([activity]);

    const beforeFailure = repository.read();
    expect(() =>
      repository.transact((draft) => {
        draft.approvalCards.clear();
        draft.sourcedProspects.clear();
        draft.activityLog.length = 0;
        throw new Error('rollback approval/provenance draft');
      })
    ).toThrow('rollback approval/provenance draft');
    expect(repository.read()).toEqual(beforeFailure);

    ledger.set('scope-hash-secret', ledgerEntry());
    const revisionBeforeReset = repository.getRevision();
    const reset = repository.reset();
    expect(reset.revision).toBe(revisionBeforeReset + 1);
    expect(reset.approvalCards).toEqual(new Map());
    expect(reset.sourcedProspects).toEqual(new Map());
    expect(reset.activityLog).toEqual([]);
    expect(ledger.get('scope-hash-secret')).toBeUndefined();
  });

  it('projects only safe approval/provenance fields and passes actor scope to filters', () => {
    const repository = new SharedStateRepository(createSeed());
    const card = approvalCard();
    const prospect = {
      ...sourcedProspect(),
      rawConsentEvidence: 'private evidence contents',
      privateContact: 'private@example.com'
    } as unknown as SourcedProspectRecord;
    const activity = activityEntry();

    repository.transact((draft) => {
      draft.approvalCards.set(card.id, card);
      draft.sourcedProspects.set(prospect.id, prospect);
      draft.activityLog.push(activity);
    });

    const actor = { actorType: 'human_ui' as const, actorId: 'sarah-recruiter' };
    const seenActors: string[] = [];
    const projection = serializeSharedState(repository.read(), {
      actor,
      approvalCardFilter: (_record, scopedActor) => {
        seenActors.push(scopedActor?.actorId ?? 'missing');
        return scopedActor?.actorId === actor.actorId;
      },
      sourcedProspectFilter: (_record, scopedActor) =>
        scopedActor?.actorId === actor.actorId,
      activityFilter: (_record, scopedActor) =>
        scopedActor?.actorType === actor.actorType
    });

    expect(seenActors).toEqual([actor.actorId]);
    expect(projection.approvalCards).toHaveLength(1);
    expect(projection.sourcedProspects).toHaveLength(1);

    const projectedCard = projection.approvalCards?.[0] as unknown as Record<string, unknown>;
    expect(projectedCard).not.toHaveProperty('normalizedInput');
    expect(projectedCard).not.toHaveProperty('requestFingerprint');
    expect(projectedCard).not.toHaveProperty('targetFingerprint');
    expect(projectedCard.proposedOutput).toEqual({
      sourcedProspectId: 'prospect-1',
      status: 'pending'
    });

    const projectedProspect = projection.sourcedProspects?.[0] as unknown as Record<string, unknown>;
    expect(projectedProspect).not.toHaveProperty('rawConsentEvidence');
    expect(projectedProspect).not.toHaveProperty('privateContact');
    expect(projectedProspect.consent).toMatchObject({
      method: 'approved_consent_channel',
      evidenceRef: 'consent-evidence-ref-1'
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('private normalized resume');
    expect(serialized).not.toContain('private nested input');
    expect(serialized).not.toContain('private evidence contents');
    expect(serialized).not.toContain('idempotency-secret');
    expect(serialized).not.toContain('request-fingerprint-secret');
    expect(serialized).not.toContain('target-fingerprint-secret');
    expect(serialized).not.toContain('scope-hash-secret');
    expect(serialized).toContain('consent-evidence-ref-1');
    expect(projection).not.toHaveProperty('ledger');
  });

  it('hydrates legacy projections with empty additive arrays and snapshots them safely', () => {
    const full = serializeSharedState(new SharedStateRepository(createSeed()).read());
    useStore.getState().hydrate(full);
    expect(useStore.getState().approvalCards).toEqual([]);
    expect(useStore.getState().sourcedProspects).toEqual([]);

    const legacy = { ...full } as SharedStateProjectionWithCatalogs & {
      approvalCards?: unknown;
      sourcedProspects?: unknown;
    };
    delete legacy.approvalCards;
    delete legacy.sourcedProspects;
    useStore.getState().hydrate(legacy);
    expect(useStore.getState().approvalCards).toEqual([]);
    expect(useStore.getState().sourcedProspects).toEqual([]);

    const card = approvalCard();
    const prospect = sourcedProspect();
    const extended = serializeSharedState(
      new SharedStateRepository(createSeed()).read()
    );
    extended.approvalCards = [
      {
        ...serializeSharedState(
          new SharedStateRepository({
            ...createSeed(),
            approvalCards: new Map([[card.id, card]]),
            sourcedProspects: new Map([[prospect.id, prospect]])
          }).read()
        ).approvalCards?.[0]
      }
    ];
    extended.sourcedProspects = [prospect];
    useStore.getState().hydrate(extended);
    const snapshot = useStore.getState().snapshot();
    expect(snapshot.approvalCards).toHaveLength(1);
    expect(snapshot.sourcedProspects).toHaveLength(1);
    snapshot.approvalCards!.length = 0;
    expect(useStore.getState().approvalCards).toHaveLength(1);
  });
});
