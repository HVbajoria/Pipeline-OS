/** Canonical adapter for service-owned approval-card reads. */

import type { GetApprovalCardOutput } from '../../shared/operations';
import type { OperationBoundaryAdapter } from '../operationService';

/** The service callback owns card scope checks, redaction, audit, and revision. */
export const getApprovalCard: OperationBoundaryAdapter<'get_approval_card'> = (
  _input,
  _context,
  execute
): PromiseLike<GetApprovalCardOutput> => execute();

export default getApprovalCard;
