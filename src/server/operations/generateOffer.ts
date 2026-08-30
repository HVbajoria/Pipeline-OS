import { notFoundError } from '../../shared/errors';
import type { OfferRecord } from '../../shared/models';
import type { GenerateOfferOutput } from '../../shared/operations';
import {
  assertNonNegativeNumber,
  assertRecordId
} from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/** Create a draft offer using the requisition currency and compensation band. */
export const generateOffer: OperationHandler<'generate_offer'> = (
  input,
  context
): GenerateOfferOutput => {
  const applicationId = assertRecordId(input.applicationId, 'applicationId');
  const compAmount = assertNonNegativeNumber(input.compAmount, 'compAmount');
  const application = context.state.applications.get(applicationId);

  if (application === undefined) {
    throw notFoundError(`Application ${applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: applicationId,
      field: 'applicationId'
    });
  }

  const job = context.state.jobs.get(application.jobId);
  if (job === undefined) {
    throw notFoundError(`Job ${application.jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: application.jobId,
      field: 'jobId'
    });
  }

  let offerId = context.nextId('offer');
  while (context.state.offers.has(offerId)) {
    offerId = context.nextId('offer');
  }

  const outsideBand =
    compAmount < job.compBand.min || compAmount > job.compBand.max;
  const offer: OfferRecord = {
    id: offerId,
    applicationId,
    compAmount,
    currency: job.compBand.currency,
    status: 'draft',
    counterAmount: null,
    sentAt: null,
    respondedAt: null,
    ...(outsideBand
      ? {
          compensationWarning: `Compensation amount ${compAmount} is outside the ${job.compBand.currency} band of ${job.compBand.min}-${job.compBand.max}.`
        }
      : {})
  };

  context.state.offers.set(offerId, offer);

  return { offerId, status: 'draft' };
};

export const generateOfferHandler = generateOffer;
export default generateOffer;
