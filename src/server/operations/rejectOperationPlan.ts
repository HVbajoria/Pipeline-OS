/** Canonical adapter for service-owned approval rejection. */

import type { RejectOperationPlanOutput } from '../../shared/operations';
import type { OperationBoundaryAdapter } from '../operationService';

/** The service callback owns the terminal rejection transition and audit. */
export const rejectOperationPlan: OperationBoundaryAdapter<'reject_operation_plan'> = (
  _input,
  _context,
  execute
): PromiseLike<RejectOperationPlanOutput> => execute();

export default rejectOperationPlan;
