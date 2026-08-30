/** Shared mutation handler for creating an open job requisition. */

import type { JobRequisition } from '../../shared/models';
import type { OperationHandler } from '../operationService';
import {
  assertCompensationBand,
  assertNonEmptyArray,
  assertNonEmptyString
} from '../../shared/validators';

/**
 * Create a requisition in the transaction draft owned by OperationService.
 *
 * All fields are validated before the draft is changed. The injected ID and
 * clock sources keep creation deterministic in tests while the actor context
 * supplies the authoritative creator identity for the persisted record.
 */
export const createJobRequisition: OperationHandler<'create_job_requisition'> = (
  input,
  context
) => {
  const title = assertNonEmptyString(input.title, 'title');
  const department = assertNonEmptyString(input.department, 'department');
  const requirements = assertNonEmptyArray(input.requirements, 'requirements').map(
    (requirement, index) =>
      assertNonEmptyString(requirement, `requirements[${index}]`)
  );
  const compBand = assertCompensationBand(input.compBand, 'compBand');

  // Avoid replacing a seeded or previously-created requisition if a test or
  // injected ID source happens to begin with an existing identifier.
  let jobId = context.nextId('job');
  while (context.state.jobs.has(jobId)) {
    jobId = context.nextId('job');
  }

  const requisition: JobRequisition = {
    id: jobId,
    title,
    department,
    requirements,
    compBand,
    status: 'open',
    createdBy: context.actor.actorId,
    createdAt: context.now()
  };

  context.state.jobs.set(jobId, requisition);

  return { jobId };
};

export default createJobRequisition;
