/** Atomic handler for booking one proposed interview slot. */

import { conflictError, notFoundError } from '../../shared/errors';
import { assertTransition } from '../../shared/domain/lifecycle';
import type { BookInterviewOutput } from '../../shared/operations';
import { assertRecordId, assertTimestamp } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

function sameTimestamp(left: string, right: string): boolean {
  if (left === right) return true;
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  return Number.isFinite(leftMillis) && leftMillis === rightMillis;
}

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

  // Resolve the proposal before the lifecycle guard or any draft mutation so
  // a non-matching slot is a clean, state-preserving 409.
  const matchingInterview = [...context.state.interviews.values()].find(
    (interview) =>
      interview.applicationId === applicationId &&
      interview.status === 'proposed' &&
      sameTimestamp(interview.slot, slot)
  );

  if (matchingInterview === undefined) {
    throw conflictError(
      `No proposed interview matches application ${applicationId} and slot ${slot}`,
      {
        recordType: 'Interview_Record',
        field: 'slot',
        applicationId,
        slot
      }
    );
  }

  // The lifecycle guard runs before the selected record or siblings change.
  assertTransition(application.status, 'interviewing');

  matchingInterview.status = 'booked';
  for (const interview of context.state.interviews.values()) {
    if (
      interview.applicationId === applicationId &&
      interview.id !== matchingInterview.id &&
      interview.status === 'proposed'
    ) {
      interview.status = 'cancelled';
    }
  }
  application.status = 'interviewing';

  return { interviewId: matchingInterview.id, status: 'booked' };
};

export const bookInterviewHandler = bookInterview;
export default bookInterview;
