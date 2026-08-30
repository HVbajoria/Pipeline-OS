/** Atomic handler for interviewer scorecard submission. */

import { SCORECARD_RECOMMENDATIONS, type ScorecardRecord } from '../../shared/models';
import { conflictError, notFoundError, ValidationError } from '../../shared/errors';
import type { SubmitInterviewFeedbackOutput } from '../../shared/operations';
import {
  assertEnum,
  assertNonEmptyString,
  assertNumberInRange,
  assertPlainObject,
  assertRecordId
} from '../../shared/validators';
import type { OperationHandler } from '../operationService';

export const submitInterviewFeedback: OperationHandler<
  'submit_interview_feedback'
> = (input, context): SubmitInterviewFeedbackOutput => {
  const interviewId = assertRecordId(input.interviewId, 'interviewId');
  const interviewer = assertNonEmptyString(input.interviewer, 'interviewer');
  const comments = assertNonEmptyString(input.comments, 'comments');
  const rawScores = assertPlainObject(input.competencyScores, 'competencyScores');
  const recommendation = assertEnum(
    input.recommendation,
    SCORECARD_RECOMMENDATIONS,
    'recommendation'
  );

  if (Object.keys(rawScores).length === 0) {
    throw new ValidationError('competencyScores must not be empty', {
      field: 'competencyScores'
    });
  }

  const competencyScores: Record<string, number> = {};
  for (const [competency, score] of Object.entries(rawScores)) {
    competencyScores[competency] = assertNumberInRange(
      score,
      1,
      5,
      `competencyScores.${competency}`
    );
  }

  const interview = context.state.interviews.get(interviewId);
  if (interview === undefined) {
    throw notFoundError(`Interview ${interviewId} was not found`, {
      recordType: 'Interview_Record',
      recordId: interviewId,
      field: 'interviewId'
    });
  }

  if (interview.status !== 'booked' && interview.status !== 'completed') {
    throw conflictError(
      `Interview ${interviewId} is not booked or completed`,
      {
        recordType: 'Interview_Record',
        recordId: interviewId,
        field: 'status',
        status: interview.status
      }
    );
  }

  let scorecardId = context.nextId('scorecard');
  while (context.state.scorecards.has(scorecardId)) {
    scorecardId = context.nextId('scorecard');
  }

  const scorecard: ScorecardRecord = {
    id: scorecardId,
    interviewId,
    interviewer,
    competencyScores,
    recommendation,
    comments,
    submittedAt: context.now()
  };
  context.state.scorecards.set(scorecardId, scorecard);
  interview.status = 'completed';

  return { scorecardId };
};

export const submitInterviewFeedbackHandler = submitInterviewFeedback;
export default submitInterviewFeedback;
