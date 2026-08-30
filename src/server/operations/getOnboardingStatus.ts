import { calculateOnboardingStatus } from '../../shared/domain/onboarding';
import { notFoundError } from '../../shared/errors';
import type { GetOnboardingStatusOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/** Read and aggregate all post-offer records for one offer. */
export const getOnboardingStatus: OperationHandler<'get_onboarding_status'> = (
  input,
  context
): GetOnboardingStatusOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
  if (!context.state.offers.has(offerId)) {
    throw notFoundError(`Offer ${offerId} was not found`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'offerId'
    });
  }

  return calculateOnboardingStatus({
    offerId,
    backgroundChecks: [...context.state.backgroundChecks.values()],
    benefitsEnrollments: [...context.state.benefitsEnrollments.values()],
    tasks: [...context.state.onboardingTasks.values()]
  });
};

export const getOnboardingStatusHandler = getOnboardingStatus;
export default getOnboardingStatus;
