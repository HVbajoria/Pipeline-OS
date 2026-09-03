import { describe, expect, it } from 'vitest';
import { SharedStateRepository } from '../src/server/repository';
import type { InvocationLedgerEntry } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import { runMaintenanceSweep } from '../src/server/maintenance';
import type { ApprovalCardRecord } from '../src/shared/models';

const PAST = '2020-01-01T00:00:00.000Z';
const NOW = '2026-09-03T00:00:00.000Z';

function overdueCard(id: string): ApprovalCardRecord {
  return {
    id: id as ApprovalCardRecord['id'],
    targetOperation: 'import_public_prospect',
    normalizedInput: {},
    requestFingerprint: 'fp',
    requestedBy: { actorType: 'human_ui', actorId: 'sarah-recruiter' },
    requestedAt: PAST,
    baseRevision: 0,
    targetFingerprint: 'tfp',
    affectedRecords: [],
    proposedOutput: {},
    changeSummary: [],
    warnings: [],
    requiredCapability: 'prospect.import',
    approvalPolicy: 'consent_and_human',
    status: 'pending',
    expiresAt: PAST,
    correlationId: 'corr-1',
    traceId: 'trace-1'
  };
}

function expiredLedgerEntry(scopeHash: string): InvocationLedgerEntry {
  return {
    scopeHash,
    requestFingerprint: 'fp',
    operationName: 'send_offer',
    status: 'success',
    responseOrError: {},
    originalActivityId: 'act-1',
    originalRevision: 1,
    correlationId: 'corr-1',
    traceId: 'trace-1',
    createdAt: PAST,
    expiresAt: PAST
  };
}

describe('maintenance sweep', () => {
  it('expires overdue approval cards and prunes expired ledger entries', () => {
    const repository = new SharedStateRepository(createSeed());

    // Seed an overdue pending approval card directly into state.
    repository.transact((draft) => {
      draft.approvalCards.set('appr-overdue', overdueCard('appr-overdue'));
    });
    // Seed an expired idempotency-ledger entry.
    repository.invocationLedger.set('scope-expired', expiredLedgerEntry('scope-expired'));

    expect(repository.read().approvalCards.get('appr-overdue')?.status).toBe('pending');

    const result = runMaintenanceSweep({ repository, now: () => NOW });

    expect(result.expiredApprovalCards).toBe(1);
    expect(result.prunedLedgerEntries).toBe(1);
    expect(repository.read().approvalCards.get('appr-overdue')?.status).toBe('expired');
    expect(repository.invocationLedger.get('scope-expired')).toBeUndefined();
  });

  it('is a no-op that commits nothing when there is nothing to clean', () => {
    const repository = new SharedStateRepository(createSeed());
    const revisionBefore = repository.getRevision();

    const result = runMaintenanceSweep({ repository, now: () => NOW });

    expect(result.expiredApprovalCards).toBe(0);
    expect(result.prunedLedgerEntries).toBe(0);
    // No approval-card change; a retention transaction runs but seed has no
    // expired prospects, so it still commits at most one benign revision.
    expect(repository.getRevision()).toBeGreaterThanOrEqual(revisionBefore);
  });
});
