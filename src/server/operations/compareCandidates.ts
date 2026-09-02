import { compareCandidates as calculateComparisons } from '../../shared/domain/comparison';
import { MAX_COMPARISON_CANDIDATES } from '../../shared/operations';
import type { CompareCandidatesOutput } from '../../shared/operations';
import { ForbiddenError, ValidationError, notFoundError } from '../../shared/errors';
import type { ResourceScope, TrustedPrincipal } from '../authorization';
import type { OperationHandler } from '../operationService';
import { assertRecordId } from '../../shared/validators';

function scopeAllows(
  principal: TrustedPrincipal,
  resourceType: string,
  resourceId: string
): boolean {
  if (principal.roles.includes('admin') || principal.roles.includes('system')) return true;
  return principal.resourceScopes.some((scope: ResourceScope) => {
    if (scope.resourceType !== resourceType && scope.resourceType !== '*') return false;
    if (scope.mode === 'none') return false;
    if (scope.mode === 'all') return true;
    return (scope.resourceIds ?? scope.ids ?? []).includes(resourceId) ||
      (scope.mode === 'self' && scope.subjectId === resourceId);
  });
}

function assertJobScope(context: Parameters<OperationHandler<'compare_candidates'>>[1], jobId: string): void {
  const principal = context.principal;
  if (principal !== undefined && !scopeAllows(principal, 'job', jobId)) {
    // Do not include the requested ID or record existence in a denial detail.
    throw new ForbiddenError('You do not have permission to perform this action', {
      reason: 'resource_scope'
    });
  }
}

/** Compare permitted candidates against one job using the shared pure scorer. */
export const compareCandidates: OperationHandler<'compare_candidates'> = (
  input,
  context
): CompareCandidatesOutput => {
  const jobId = assertRecordId(input.jobId, 'jobId');
  const candidateIds = input.candidateIds.map((candidateId) =>
    assertRecordId(candidateId, 'candidateIds')
  );
  if (
    candidateIds.length < 2 ||
    candidateIds.length > MAX_COMPARISON_CANDIDATES ||
    new Set(candidateIds).size !== candidateIds.length
  ) {
    throw new ValidationError(
      `candidateIds must contain two to ${MAX_COMPARISON_CANDIDATES} unique candidates`,
      { field: 'candidateIds', reason: 'input_invalid' }
    );
  }

  // Authorization is normally evaluated by OperationService first. The
  // handler repeats the job-scope invariant for direct/test handler seams so
  // a trusted principal can never receive an out-of-scope comparison.
  assertJobScope(context, jobId);
  const job = context.state.jobs.get(jobId);
  if (job === undefined) {
    throw notFoundError(`Job ${jobId} was not found`, {
      recordType: 'Job_Requisition',
      recordId: jobId,
      field: 'jobId'
    });
  }

  const candidates = candidateIds.map((candidateId) => {
    const principal = context.principal;
    if (principal !== undefined && !scopeAllows(principal, 'candidate', candidateId)) {
      throw new ForbiddenError('You do not have permission to perform this action', {
        reason: 'resource_scope'
      });
    }
    const candidate = context.state.candidates.get(candidateId);
    if (candidate === undefined) {
      throw notFoundError(`Candidate ${candidateId} was not found`, {
        recordType: 'Candidate_Record',
        recordId: candidateId,
        field: 'candidateIds'
      });
    }
    return candidate;
  });

  return {
    jobId,
    revision: context.state.revision,
    candidates: calculateComparisons(job, candidates)
  };
};

export const compareCandidatesHandler = compareCandidates;
export default compareCandidates;
