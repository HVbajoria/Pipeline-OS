/** Read-only handler for deterministic role-specific interview kits. */

import { InternalError, notFoundError } from '../../shared/errors';
import { selectRoleTemplate } from '../../shared/domain/onboarding';
import type { GetInterviewKitOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import { deepClone } from '../repository';
import type { OperationHandler } from '../operationService';

export const getInterviewKit: OperationHandler<'get_interview_kit'> = (
  input,
  context
): GetInterviewKitOutput => {
  const jobId = assertRecordId(input.jobId, 'jobId');
  const job = context.state.jobs.get(jobId);
  if (job === undefined) {
    throw notFoundError(`Job ${jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: jobId,
      field: 'jobId'
    });
  }

  const template = selectRoleTemplate(job, context.state.catalogs.roleTemplates);
  if (template === undefined) {
    throw new InternalError(`No role template is configured for job ${jobId}`, {
      recordType: 'Role_Template',
      recordId: jobId
    });
  }

  return {
    competencies: deepClone(template.competencies)
  };
};

export const getInterviewKitHandler = getInterviewKit;
export default getInterviewKit;
