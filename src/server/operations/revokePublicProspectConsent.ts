import { ForbiddenError, NotFoundError } from '../../shared/errors';
import type { SourcedProspectId } from '../../shared/models';
import type {
  RevokePublicProspectConsentInput,
  RevokePublicProspectConsentOutput
} from '../../shared/operations';
import { normalizePublicProspectTimestamp } from '../../shared/domain/provenance';
import { assertNonEmptyString, assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';
import {
  applyPublicProspectLinkedCandidateRetention,
  priorWithdrawalTimestamp,
  PUBLIC_PROSPECT_WITHDRAWAL_RETENTION_ACTION
} from './importPublicProspect';

/**
 * Withdraw consent on a sourced prospect without deleting the safe provenance
 * record or its audit fact. Repeated calls return the original withdrawal
 * timestamp and never revive or duplicate candidate data.
 */
export const revokePublicProspectConsent: OperationHandler<
  'revoke_public_prospect_consent'
> = (
  input: RevokePublicProspectConsentInput,
  context
): RevokePublicProspectConsentOutput => {
  if (context.actor.actorType !== 'human_ui') {
    throw new ForbiddenError('Only a trusted human may revoke public-prospect consent', {
      reason: 'approval_principal_required'
    });
  }

  const sourcedProspectId = assertRecordId(
    input.sourcedProspectId,
    'sourcedProspectId'
  ) as SourcedProspectId;
  if (input.reason !== undefined) {
    assertNonEmptyString(input.reason, 'reason');
  }

  const record = context.state.sourcedProspects.get(sourcedProspectId);
  if (record === undefined) {
    throw new NotFoundError('Sourced public prospect was not found', {
      reason: 'record_not_found',
      recordType: 'Sourced_Prospect_Record',
      recordId: sourcedProspectId,
      field: 'sourcedProspectId'
    });
  }

  const existingWithdrawal =
    record.consentStatus === 'withdrawn'
      ? priorWithdrawalTimestamp(context.state, sourcedProspectId)
      : undefined;
  const withdrawnAt =
    record.withdrawnAt ?? existingWithdrawal ?? normalizePublicProspectTimestamp(context.now(), 'now');

  record.consentStatus = 'withdrawn';
  record.withdrawnAt = withdrawnAt;
  applyPublicProspectLinkedCandidateRetention(context.state, record);

  return {
    sourcedProspectId,
    status: 'withdrawn',
    withdrawnAt,
    retentionAction: PUBLIC_PROSPECT_WITHDRAWAL_RETENTION_ACTION
  };
};

export const revokePublicProspectConsentHandler = revokePublicProspectConsent;
export default revokePublicProspectConsent;
