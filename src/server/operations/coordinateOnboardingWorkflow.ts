import {
  assertTransition
} from '../../shared/domain/lifecycle';
import {
  calculateOnboardingStatus,
  scheduleOnboardingTasks,
  selectRoleTemplate
} from '../../shared/domain/onboarding';
import {
  assertTaskStatusTransition,
  equivalentOnboardingChecklist,
  taskStatusTransitionKind
} from '../../shared/domain/onboardingWorkflow';
import { calculateRecruitingWorkflowStatus } from '../../shared/domain/workflowStatus';
import { ForbiddenError, conflictError, notFoundError } from '../../shared/errors';
import {
  ONBOARDING_TASK_STATUSES,
  type OnboardingTaskRecord
} from '../../shared/models';
import {
  MAX_APPROVAL_SUMMARY_ITEMS,
  MAX_WORKFLOW_STATUS_ITEMS,
  type CoordinateOnboardingWorkflowOutput,
  type OnboardingTaskSummary
} from '../../shared/operations';
import {
  assertEnum,
  assertRecordId
} from '../../shared/validators';
import type {
  OperationHandler,
  OperationHandlerContext
} from '../operationService';

const ONBOARDING_ACTIONS = ['initialize_checklist', 'update_task'] as const;
type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];

type OnboardingContext = OperationHandlerContext<'coordinate_onboarding_workflow'>;

function boundedText(value: string, maximum = 300): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum
    ? trimmed
    : `${trimmed.slice(0, Math.max(1, maximum - 1))}…`;
}

function boundedStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .slice(0, MAX_APPROVAL_SUMMARY_ITEMS)
    .map((value) => boundedText(value));
}

function taskSummary(task: OnboardingTaskRecord): OnboardingTaskSummary {
  return {
    taskId: task.id,
    taskName: boundedText(task.taskName, 200),
    dueDate: task.dueDate,
    status: task.status
  };
}

function correctionAuthorized(context: OnboardingContext): boolean {
  const principal = context.principal;
  // Legacy direct callers have no principal; their human actor is the
  // compatibility recruiter boundary. Policy-backed calls use trusted roles.
  if (principal === undefined) return context.actor.actorType === 'human_ui';
  if (
    !principal.authenticated ||
    !principal.trusted ||
    principal.authenticationStatus !== 'authenticated'
  ) {
    return false;
  }
  return principal.roles.some(
    (role) => role === 'recruiter' || role === 'admin' || role === 'system'
  );
}

function onboardingOutput(
  offerId: string,
  applicationId: string,
  changedTasks: readonly OnboardingTaskRecord[],
  context: OnboardingContext
): CoordinateOnboardingWorkflowOutput {
  const status = calculateOnboardingStatus({
    offerId,
    backgroundChecks: [...context.state.backgroundChecks.values()],
    benefitsEnrollments: [...context.state.benefitsEnrollments.values()],
    tasks: [...context.state.onboardingTasks.values()]
  });
  const workflow = calculateRecruitingWorkflowStatus(
    context.state,
    { applicationId },
    { generatedAt: context.now(), limit: 1 }
  );
  const summary = workflow.applications[0];

  return {
    offerId,
    changedTasks: changedTasks
      .slice(0, MAX_WORKFLOW_STATUS_ITEMS)
      .map(taskSummary),
    backgroundCheckStatus: status.backgroundCheckStatus,
    benefitsEnrolled: status.benefitsEnrolled,
    taskCompletion: status.taskCompletion,
    completionPercentage: status.completionPercentage,
    blockers: boundedStrings(summary?.blockers ?? workflow.blockers),
    nextActions: boundedStrings(summary?.nextActions ?? workflow.nextActions)
  };
}

export const coordinateOnboardingWorkflow: OperationHandler<
  'coordinate_onboarding_workflow'
> = (input, context): CoordinateOnboardingWorkflowOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
  const action = assertEnum(
    input.action,
    ONBOARDING_ACTIONS,
    'action'
  ) as OnboardingAction;
  const offer = context.state.offers.get(offerId);

  if (offer === undefined) {
    throw notFoundError(`Offer ${offerId} was not found`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'offerId'
    });
  }

  if (offer.status !== 'accepted') {
    throw conflictError(
      `Offer ${offerId} must be accepted before onboarding can be coordinated`,
      {
        recordType: 'Offer_Record',
        recordId: offerId,
        field: 'status',
        status: offer.status
      }
    );
  }

  const application = context.state.applications.get(offer.applicationId);
  if (application === undefined) {
    throw notFoundError(`Application ${offer.applicationId} was not found`, {
      recordType: 'Application_Record',
      recordId: offer.applicationId,
      field: 'applicationId'
    });
  }

  if (action === 'initialize_checklist') {
    const job = context.state.jobs.get(application.jobId);
    if (job === undefined) {
      throw notFoundError(`Job ${application.jobId} was not found`, {
        recordType: 'Job_Requisition',
        recordId: application.jobId,
        field: 'jobId'
      });
    }

    const template = selectRoleTemplate(job, context.state.catalogs.roleTemplates);
    if (template === undefined) {
      throw conflictError(`No onboarding role template is available for job ${job.id}`, {
        recordType: 'Role_Template',
        recordId: job.id
      });
    }

    const scheduledTasks = scheduleOnboardingTasks(
      template,
      context.state.catalogs.startDate
    );
    const existingTasks = [...context.state.onboardingTasks.values()].filter(
      (task) => task.offerId === offerId
    );

    if (existingTasks.length > 0) {
      const equivalentTasks = equivalentOnboardingChecklist(
        existingTasks,
        scheduledTasks
      );
      if (equivalentTasks === undefined) {
        throw conflictError(
          `Existing onboarding checklist for offer ${offerId} does not match the selected role template`,
          {
            recordType: 'Onboarding_Task_Record',
            field: 'offerId'
          }
        );
      }
      if (application.status !== 'onboarding') {
        throw conflictError(
          `Existing onboarding checklist for offer ${offerId} is incompatible with application status ${application.status}`,
          {
            recordType: 'Application_Record',
            recordId: application.id,
            field: 'status',
            status: application.status
          }
        );
      }
      return onboardingOutput(offerId, application.id, equivalentTasks, context);
    }

    const span = context.trace.startChild('onboarding.initialize_checklist', {
      offerId,
      applicationId: application.id,
      taskCount: scheduledTasks.length
    });
    try {
      // Validate the lifecycle edge before allocating or writing any task.
      // The command creates all records only after every ID has been resolved.
      assertTransition(application.status, 'onboarding');
      const taskRecords: OnboardingTaskRecord[] = [];
      for (const scheduled of scheduledTasks) {
        let taskId = context.nextId('onboarding-task');
        while (
          context.state.onboardingTasks.has(taskId) ||
          taskRecords.some((task) => task.id === taskId)
        ) {
          taskId = context.nextId('onboarding-task');
        }
        taskRecords.push({
          id: taskId,
          offerId,
          taskName: scheduled.taskName,
          status: 'pending',
          dueDate: scheduled.dueDate
        });
      }
      for (const task of taskRecords) {
        context.state.onboardingTasks.set(task.id, task);
      }
      application.status = 'onboarding';
      context.trace.completeSpan(span, 'completed', {
        taskCount: taskRecords.length
      });
      return onboardingOutput(offerId, application.id, taskRecords, context);
    } catch (error) {
      context.trace.completeSpan(span, 'failed');
      throw error;
    }
  }

  const taskId = assertRecordId(input.taskId, 'taskId');
  const status = assertEnum(
    input.status,
    ONBOARDING_TASK_STATUSES,
    'status'
  );
  const task = context.state.onboardingTasks.get(taskId);
  if (task === undefined || task.offerId !== offerId) {
    throw notFoundError(`Onboarding task ${taskId} was not found for offer ${offerId}`, {
      recordType: 'Onboarding_Task_Record',
      field: 'taskId'
    });
  }

  if (application.status !== 'onboarding') {
    throw conflictError(
      `Application ${application.id} must be onboarding before task status can be updated`,
      {
        recordType: 'Application_Record',
        recordId: application.id,
        field: 'status',
        status: application.status
      }
    );
  }

  const transition = taskStatusTransitionKind(task.status, status);
  if (transition === 'correction' && !correctionAuthorized(context)) {
    throw new ForbiddenError(
      `Onboarding task ${task.id} requires an authorized correction`,
      {
        recordType: 'Onboarding_Task_Record',
        field: 'status',
        reason: 'capability_denied',
        requiredCapability: 'onboarding.coordinate'
      }
    );
  }

  const span = context.trace.startChild('onboarding.update_task', {
    offerId,
    taskId,
    status
  });
  try {
    const allowCorrection = transition === 'correction';
    assertTaskStatusTransition(task, status, allowCorrection);
    if (transition !== 'noop') task.status = status;
    context.trace.completeSpan(span, 'completed', {
      transition,
      status
    });
    return onboardingOutput(offerId, application.id, [task], context);
  } catch (error) {
    context.trace.completeSpan(span, 'failed');
    throw error;
  }
};

export const coordinateOnboardingWorkflowHandler = coordinateOnboardingWorkflow;
export default coordinateOnboardingWorkflow;
