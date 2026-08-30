/** Read-only handler for application-wide interview feedback aggregation. */

import { notFoundError } from '../../shared/errors';
import { aggregatePanelFeedback } from '../../shared/domain/feedback';
import type { GetPanelFeedbackSummaryOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

export const getPanelFeedbackSummary: OperationHandler<
  'get_panel_feedback_summary'
> = (input, context): GetPanelFeedbackSummaryOutput => {
  const applicationId = assertRecordId(input.applicationId, 'applicationId');
  if (!context.state.applications.has(applicationId)) {
    throw notFoundError(`Application ${applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: applicationId,
      field: 'applicationId'
    });
  }

  return aggregatePanelFeedback(
    applicationId,
    context.state.interviews,
    context.state.scorecards
  );
};

export const getPanelFeedbackSummaryHandler = getPanelFeedbackSummary;
export default getPanelFeedbackSummary;
