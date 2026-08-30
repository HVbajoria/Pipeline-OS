/** Read-only handler for common interviewer availability. */

import { notFoundError } from '../../shared/errors';
import { assertValidDateRange } from '../../shared/domain/scheduling';
import type { CheckInterviewerAvailabilityOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';
import { commonFreeSlotsForPanel } from './panelAvailability';

export const checkInterviewerAvailability: OperationHandler<
  'check_interviewer_availability'
> = (input, context): CheckInterviewerAvailabilityOutput => {
  const panelId = assertRecordId(input.panelId, 'panelId');
  assertValidDateRange(input.dateRange);

  const panel = context.state.panels.get(panelId);
  if (panel === undefined) {
    throw notFoundError(`Interview panel ${panelId} was not found`, {
      recordType: 'Interview_Panel',
      recordId: panelId,
      field: 'panelId'
    });
  }

  return {
    commonFreeSlots: commonFreeSlotsForPanel(
      context.state,
      panel,
      input.dateRange
    )
  };
};

export const checkInterviewerAvailabilityHandler = checkInterviewerAvailability;
export default checkInterviewerAvailability;
