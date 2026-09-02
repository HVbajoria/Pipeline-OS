/** Atomic handler for booking one proposed interview slot. */

import { bookInterviewSlot } from '../../shared/domain/interviewWorkflow';
import { notFoundError } from '../../shared/errors';
import type { BookInterviewOutput } from '../../shared/operations';
import { assertRecordId, assertTimestamp } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

export const bookInterview: OperationHandler<'book_interview'> = (
  input,
  context
): BookInterviewOutput => {
  const applicationId = assertRecordId(input.applicationId, 'applicationId');
  const slot = assertTimestamp(input.slot, 'slot');
  const application = context.state.applications.get(applicationId);

  if (application === undefined) {
    throw notFoundError(`Application ${applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: applicationId,
      field: 'applicationId'
    });
  }

  const result = bookInterviewSlot(
    application,
    context.state.interviews,
    slot
  );

  return { interviewId: result.interview.id, status: 'booked' };
};

export const bookInterviewHandler = bookInterview;
export default bookInterview;
