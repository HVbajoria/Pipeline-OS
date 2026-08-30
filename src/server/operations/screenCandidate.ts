import { assertTransition } from '../../shared/domain/lifecycle';
import { calculateScreening } from '../../shared/domain/scoring';
import { notFoundError } from '../../shared/errors';
import type { ScreenCandidateOutput } from '../../shared/operations';
import type { OperationHandler } from '../operationService';

/**
 * Screen an application using the deterministic requirements/experience
 * scorer and persist the resulting explanation on the application record.
 *
 * The operation service supplies an isolated transaction draft for this
 * mutation. References are resolved before any record is changed, and the
 * lifecycle guard rejects retries or skipped/reverse transitions before the
 * score is calculated or persisted.
 */
export const screenCandidate: OperationHandler<'screen_candidate'> = (
  input,
  context
): ScreenCandidateOutput => {
  const application = context.state.applications.get(input.applicationId);
  if (application === undefined) {
    throw notFoundError(`Application ${input.applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: input.applicationId
    });
  }

  const candidate = context.state.candidates.get(application.candidateId);
  if (candidate === undefined) {
    throw notFoundError(`Candidate ${application.candidateId} was not found`, {
      recordType: 'Candidate_Record',
      recordId: application.candidateId
    });
  }

  const job = context.state.jobs.get(application.jobId);
  if (job === undefined) {
    throw notFoundError(`Job ${application.jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: application.jobId
    });
  }

  assertTransition(application.status, 'screened');

  const calculation = calculateScreening(candidate, job);
  application.screeningScore = calculation.score;
  application.screeningRationale = calculation.rationale;
  application.status = 'screened';

  return {
    applicationId: application.id,
    screeningScore: calculation.score,
    screeningRationale: calculation.rationale,
    status: 'screened'
  };
};

export default screenCandidate;
