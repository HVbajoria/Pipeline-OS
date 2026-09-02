/** Canonical adapter for service-owned approval decisions. */

import type { ApproveOperationPlanOutput } from '../../shared/operations';
import type { OperationBoundaryAdapter } from '../operationService';

/** The service callback owns trusted-human policy and the atomic card update. */
export const approveOperationPlan: OperationBoundaryAdapter<'approve_operation_plan'> = (
  _input,
  _context,
  execute
): PromiseLike<ApproveOperationPlanOutput> => execute();

export default approveOperationPlan;
