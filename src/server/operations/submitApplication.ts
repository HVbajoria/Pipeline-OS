import { conflictError, notFoundError, InternalError } from '../../shared/errors';
import { isPreOfferStatus } from '../../shared/domain/lifecycle';
import type { ApplicationRecord } from '../../shared/models';
import type {
  SubmitApplicationInput,
  SubmitApplicationOutput
} from '../../shared/operations';
import type { OperationHandler } from '../operationService';
import {
  assertNonEmptyString,
  assertRecordId
} from '../../shared/validators';

/**
 * The lifecycle module owns the pre-offer state set. A newly submitted
 * application always enters the first state in that set; it never skips
 * directly to a later screening or interview state.
 */
function initialApplicationStatus(): SubmitApplicationOutput['status'] {
  const status: SubmitApplicationOutput['status'] = 'applied';
  if (!isPreOfferStatus(status)) {
    throw new InternalError('Application lifecycle has no applied entry state');
  }
  return status;
}

/**
 * Submit an application against an open requisition.
 *
 * This handler mutates only the transaction draft supplied by OperationService.
 * The service owns the atomic commit, output validation, and exactly-once
 * activity audit for the invocation.
 */
export const submitApplication: OperationHandler<'submit_application'> = (
  input: SubmitApplicationInput,
  context
): SubmitApplicationOutput => {
  const candidateId = assertRecordId(input.candidateId, 'candidateId');
  const jobId = assertRecordId(input.jobId, 'jobId');
  const resumeText = assertNonEmptyString(input.resumeText, 'resumeText');

  const candidate = context.state.candidates.get(candidateId);
  if (candidate === undefined) {
    throw notFoundError(`Candidate ${candidateId} was not found`, {
      recordType: 'Candidate_Record',
      recordId: candidateId,
      field: 'candidateId'
    });
  }

  const job = context.state.jobs.get(jobId);
  if (job === undefined) {
    throw notFoundError(`Job ${jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: jobId,
      field: 'jobId'
    });
  }

  if (job.status !== 'open') {
    throw conflictError(`Job ${jobId} is not open for applications`, {
      recordType: 'Job_Requisition',
      recordId: jobId,
      field: 'status',
      status: job.status
    });
  }

  const duplicate = [...context.state.applications.values()].find(
    (application) =>
      application.candidateId === candidateId && application.jobId === jobId
  );
  if (duplicate !== undefined) {
    throw conflictError(
      `An application already exists for candidate ${candidateId} and job ${jobId}`,
      {
        recordType: 'Application_Record',
        recordId: duplicate.id,
        field: 'candidateId/jobId'
      }
    );
  }

  const status = initialApplicationStatus();
  const applicationId = context.nextId('application');
  const application: ApplicationRecord = {
    id: applicationId,
    candidateId,
    jobId,
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: context.now()
  };

  context.state.applications.set(applicationId, application);

  if (
    resumeText !== candidate.resumeText &&
    !candidate.resumeTextHistory.includes(resumeText)
  ) {
    candidate.resumeTextHistory.push(resumeText);
  }

  return { applicationId, status };
};

export const submitApplicationHandler = submitApplication;
export default submitApplication;
