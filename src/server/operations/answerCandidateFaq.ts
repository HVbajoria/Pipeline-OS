/** Shared read-only handler for deterministic, requisition-only candidate FAQs. */

import { composeFaqAnswer } from '../../shared/domain/faq';
import { ForbiddenError, notFoundError } from '../../shared/errors';
import type { AnswerCandidateFaqInput, AnswerCandidateFaqOutput } from '../../shared/operations';
import { assertNonEmptyString, assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/**
 * Answer a candidate's question from the isolated operation snapshot.
 *
 * The FAQ composer is deliberately pure and receives only the requisition
 * fields permitted by the operation contract. The operation service supplies
 * a disposable snapshot because this operation is read-only; this handler
 * never calls an external service or mutates shared domain records.
 */
export const answerCandidateFaq: OperationHandler<'answer_candidate_faq'> = (
  input: AnswerCandidateFaqInput,
  context
): AnswerCandidateFaqOutput => {
  const jobId = assertRecordId(input.jobId, 'jobId');
  const question = assertNonEmptyString(input.question, 'question');
  const job = context.state.jobs.get(jobId);

  if (job === undefined) {
    throw notFoundError(`Job ${jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: jobId,
      field: 'jobId',
      suggestedOperation: 'list_open_jobs'
    });
  }

  if (context.principal?.roles.includes('candidate') && job.status !== 'open') {
    throw new ForbiddenError('You do not have permission to perform this action', {
      reason: 'resource_scope',
      resourceScope: 'job:open'
    });
  }

  return composeFaqAnswer(job, question);
};

/** Alias used by composition roots that register handlers by implementation name. */
export const answerCandidateFaqHandler = answerCandidateFaq;

export default answerCandidateFaq;
