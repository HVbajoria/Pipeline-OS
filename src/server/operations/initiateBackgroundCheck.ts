import { conflictError, notFoundError } from '../../shared/errors';
import type { BackgroundCheckRecord } from '../../shared/models';
import type { InitiateBackgroundCheckOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/** Create and synchronously resolve the deterministic background-check record. */
export const initiateBackgroundCheck: OperationHandler<
  'initiate_background_check'
> = (input, context): InitiateBackgroundCheckOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
  const offer = context.state.offers.get(offerId);

  if (offer === undefined) {
    throw notFoundError(`Offer ${offerId} was not found`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'offerId'
    });
  }

  if (offer.status !== 'accepted') {
    throw conflictError(
      `Offer ${offerId} must be accepted before a background check can be initiated`,
      {
        recordType: 'Offer_Record',
        recordId: offerId,
        field: 'status',
        status: offer.status
      }
    );
  }

  let backgroundCheckId = context.nextId('background-check');
  while (context.state.backgroundChecks.has(backgroundCheckId)) {
    backgroundCheckId = context.nextId('background-check');
  }

  const initiatedAt = context.now();
  const backgroundCheck: BackgroundCheckRecord = {
    id: backgroundCheckId,
    offerId,
    status: 'pending',
    initiatedAt,
    completedAt: null
  };
  context.state.backgroundChecks.set(backgroundCheckId, backgroundCheck);

  // The demo's external check is deterministic and completes in this transaction.
  backgroundCheck.status = 'clear';
  backgroundCheck.completedAt = context.now();

  return { backgroundCheckId, status: 'clear' };
};

export const initiateBackgroundCheckHandler = initiateBackgroundCheck;
export default initiateBackgroundCheck;
