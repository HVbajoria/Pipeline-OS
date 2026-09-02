import {
  calculateRecruitingWorkflowStatus
} from '../../shared/domain/workflowStatus';
import { ForbiddenError, notFoundError } from '../../shared/errors';
import type { ApplicationRecord } from '../../shared/models';
import type {
  GetRecruitingWorkflowStatusOutput
} from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type {
  ResourceScope,
  TrustedPrincipal
} from '../authorization';
import type {
  OperationHandler,
  OperationHandlerContext
} from '../operationService';

function scopeAllows(
  principal: TrustedPrincipal,
  resourceType: string,
  resourceId: string,
  subjectId?: string
): boolean {
  if (principal.roles.includes('admin') || principal.roles.includes('system')) return true;
  return principal.resourceScopes.some((scope: ResourceScope) => {
    if (scope.resourceType !== resourceType && scope.resourceType !== '*') return false;
    if (scope.mode === 'none') return false;
    if (scope.mode === 'all') return true;
    const ids = scope.resourceIds ?? scope.ids ?? [];
    return ids.includes(resourceId) ||
      (scope.mode === 'self' &&
        (scope.subjectId === resourceId ||
          (subjectId !== undefined && scope.subjectId === subjectId)));
  });
}

function panelVisible(
  context: OperationHandlerContext<'get_recruiting_workflow_status'>,
  application: ApplicationRecord,
  principal: TrustedPrincipal
): boolean {
  return [...context.state.panels.values()]
    .filter((panel) => panel.jobId === application.jobId)
    .some((panel) => scopeAllows(principal, 'panel', panel.id));
}

function applicationVisible(
  context: OperationHandlerContext<'get_recruiting_workflow_status'>,
  application: ApplicationRecord,
  principal: TrustedPrincipal
): boolean {
  if (principal.roles.includes('admin') || principal.roles.includes('system')) return true;

  if (scopeAllows(principal, 'application', application.id, application.candidateId)) {
    return true;
  }
  if (scopeAllows(principal, 'candidate', application.candidateId)) return true;
  if (scopeAllows(principal, 'job', application.jobId)) return true;
  if (panelVisible(context, application, principal)) return true;

  const offerVisible = [...context.state.offers.values()]
    .filter((offer) => offer.applicationId === application.id)
    .some((offer) => scopeAllows(principal, 'offer', offer.id, application.candidateId));
  return offerVisible;
}

function assertSelectorScope(
  context: OperationHandlerContext<'get_recruiting_workflow_status'>,
  resourceType: string,
  resourceId: string
): void {
  const principal = context.principal;
  if (principal !== undefined && !scopeAllows(principal, resourceType, resourceId)) {
    throw new ForbiddenError('You do not have permission to perform this action', {
      reason: 'resource_scope'
    });
  }
}

function approvalVisible(
  context: OperationHandlerContext<'get_recruiting_workflow_status'>,
  record: { requestedBy: { actorType: string; actorId: string }; normalizedInput: Record<string, unknown>; targetOperation: string },
  principal: TrustedPrincipal
): boolean {
  if (principal.roles.includes('admin') || principal.roles.includes('system')) return true;
  if (
    record.requestedBy.actorType === principal.actor.actorType &&
    record.requestedBy.actorId === principal.actor.actorId
  ) {
    return true;
  }

  const input = record.normalizedInput;
  if (typeof input.jobId === 'string' && scopeAllows(principal, 'job', input.jobId)) {
    return true;
  }
  if (
    typeof input.candidateId === 'string' &&
    scopeAllows(principal, 'candidate', input.candidateId)
  ) {
    return true;
  }
  if (Array.isArray(input.candidateIds)) {
    const candidateIds = input.candidateIds.filter(
      (candidateId): candidateId is string => typeof candidateId === 'string'
    );
    if (
      candidateIds.length > 0 &&
      candidateIds.every((candidateId) => scopeAllows(principal, 'candidate', candidateId))
    ) {
      return true;
    }
  }
  if (typeof input.applicationId === 'string') {
    const application = context.state.applications.get(input.applicationId);
    if (application !== undefined && applicationVisible(context, application, principal)) {
      return true;
    }
  }
  if (typeof input.offerId === 'string') {
    const offer = context.state.offers.get(input.offerId);
    const application =
      offer === undefined
        ? undefined
        : context.state.applications.get(offer.applicationId);
    if (
      offer !== undefined &&
      scopeAllows(principal, 'offer', offer.id, application?.candidateId)
    ) {
      return true;
    }
  }
  // A status read must not expose an approval card whose target cannot be
  // mapped to a trusted resource scope.
  return false;
}

function visibleIds(
  context: OperationHandlerContext<'get_recruiting_workflow_status'>,
  input: Parameters<typeof calculateRecruitingWorkflowStatus>[1]
): { applicationIds?: string[]; approvalIds?: string[] } {
  const principal = context.principal;
  if (principal === undefined) return {};

  const applicationIds = [...context.state.applications.values()]
    .filter((application) => applicationVisible(context, application, principal))
    .map((application) => application.id);
  const approvalIds = [...context.state.approvalCards.values()]
    .filter((record) => approvalVisible(context, record, principal))
    .map((record) => record.id);
  void input;
  return { applicationIds, approvalIds };
}

/** Return one snapshot-consistent, trusted-scope workflow status projection. */
export const getRecruitingWorkflowStatus: OperationHandler<
  'get_recruiting_workflow_status'
> = (input, context): GetRecruitingWorkflowStatusOutput => {
  if (input.jobId !== undefined) {
    const jobId = assertRecordId(input.jobId, 'jobId');
    assertSelectorScope(context, 'job', jobId);
    if (!context.state.jobs.has(jobId)) {
      throw notFoundError(`Job ${jobId} was not found`, {
        recordType: 'Job_Requisition',
        recordId: jobId,
        field: 'jobId'
      });
    }
  }

  if (input.candidateId !== undefined) {
    const candidateId = assertRecordId(input.candidateId, 'candidateId');
    assertSelectorScope(context, 'candidate', candidateId);
    if (!context.state.candidates.has(candidateId)) {
      throw notFoundError(`Candidate ${candidateId} was not found`, {
        recordType: 'Candidate_Record',
        recordId: candidateId,
        field: 'candidateId'
      });
    }
  }

  if (input.applicationId !== undefined) {
    const applicationId = assertRecordId(input.applicationId, 'applicationId');
    const application = context.state.applications.get(applicationId);
    if (application === undefined) {
      throw notFoundError(`Application ${applicationId} was not found`, {
        recordType: 'Application_Record',
        recordId: applicationId,
        field: 'applicationId'
      });
    }
    const principal = context.principal;
    if (principal !== undefined && !applicationVisible(context, application, principal)) {
      throw new ForbiddenError('You do not have permission to perform this action', {
        reason: 'resource_scope'
      });
    }
  }

  const visibility = visibleIds(context, input);
  return calculateRecruitingWorkflowStatus(context.state, input, {
    generatedAt: context.now(),
    detail: input.detail,
    limit: input.limit,
    visibility
  });
};

export const getRecruitingWorkflowStatusHandler = getRecruitingWorkflowStatus;
export default getRecruitingWorkflowStatus;
