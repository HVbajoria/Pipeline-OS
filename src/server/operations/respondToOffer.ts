import { assertTransition } from '../../shared/domain/lifecycle';
import { conflictError, notFoundError } from '../../shared/errors';
import { OFFER_DECISIONS } from '../../shared/models';
import type { RespondToOfferOutput } from '../../shared/operations';
import {
  assertEnum,
  assertNonNegativeNumber,
  assertRecordId
} from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/** Apply an accept, decline, or counter decision to a sent offer. */
export const respondToOffer: OperationHandler<'respond_to_offer'> = (
  input,
  context
): RespondToOfferOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
  const decision = assertEnum(input.decision, OFFER_DECISIONS, 'decision');
  const counterAmount =
    decision === 'counter'
      ? assertNonNegativeNumber(
          (input as { counterAmount?: unknown }).counterAmount,
          'counterAmount'
        )
      : undefined;

  const offer = context.state.offers.get(offerId);
  if (offer === undefined) {
    throw notFoundError(`Offer ${offerId} was not found`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'offerId'
    });
  }

  if (offer.status !== 'sent') {
    throw conflictError(`Offer ${offerId} is not sent`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'status',
      status: offer.status
    });
  }

  const application = context.state.applications.get(offer.applicationId);
  if (application === undefined) {
    throw notFoundError(`Application ${offer.applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: offer.applicationId,
      field: 'applicationId'
    });
  }

  if (decision === 'counter') {
    offer.status = 'countered';
    offer.counterAmount = counterAmount!;
    offer.respondedAt = context.now();
    return { offerId, status: 'countered' };
  }

  const applicationStatus = decision === 'accept' ? 'offer_accepted' : 'offer_declined';
  // Validate the lifecycle edge before changing either the offer or application.
  assertTransition(application.status, applicationStatus);

  offer.status = decision === 'accept' ? 'accepted' : 'declined';
  offer.respondedAt = context.now();
  application.status = applicationStatus;

  return {
    offerId,
    status: decision === 'accept' ? 'accepted' : 'declined'
  };
};

export const respondToOfferHandler = respondToOffer;
export default respondToOffer;
