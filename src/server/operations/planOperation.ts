/** Canonical adapter for service-owned plan orchestration. */

import type { PlanOperationOutput } from '../../shared/operations';
import type {
  OperationBoundaryAdapter
} from '../operationService';

/**
 * The adapter has no repository access and performs no policy or mutation.
 * OperationService supplies the callback that owns the preview transaction.
 */
export const planOperation: OperationBoundaryAdapter<'plan_operation'> = (
  _input,
  _context,
  execute
): PromiseLike<PlanOperationOutput> => execute();

export default planOperation;
