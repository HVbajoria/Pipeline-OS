/** Canonical adapter for service-owned approved-plan commits. */

import type { CommitOperationPlanOutput } from '../../shared/operations';
import type { OperationBoundaryAdapter } from '../operationService';

/** The service callback owns revalidation, target execution, and the transaction. */
export const commitOperationPlan: OperationBoundaryAdapter<'commit_operation_plan'> = (
  _input,
  _context,
  execute
): PromiseLike<CommitOperationPlanOutput> => execute();

export default commitOperationPlan;
