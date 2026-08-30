import { assertTransition } from '../../shared/domain/lifecycle';
import { conflictError, notFoundError } from '../../shared/errors';
import type { SendOfferOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/** Send a draft offer and advance its application to offer_sent. */
export const sendOffer: OperationHandler<'send_offer'> = (
  input,
  context
): SendOfferOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
  const offer = context.state.offers.get(offerId);

  if (offer === undefined) {
    throw notFoundError(`Offer ${offerId} was not found`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'offerId'
    });
  }

  if (offer.status !== 'draft') {
    throw conflictError(`Offer ${offerId} is not a draft`, {
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

  if (application.status !== 'interviewing') {
    throw conflictError(
      `Application ${application.id} must be interviewing before offer ${offerId} can be sent`,
      {
        recordType: 'Application_Record',
        recordId: application.id,
        field: 'status',
        status: application.status
      }
    );
  }

  // Keep the lifecycle module as the sole authority for application status changes.
  assertTransition(application.status, 'offer_sent');

  offer.sentAt = context.now();
  offer.status = 'sent';
  application.status = 'offer_sent';

  return { offerId, status: 'sent' };
};

export const sendOfferHandler = sendOffer;
export default sendOffer;
