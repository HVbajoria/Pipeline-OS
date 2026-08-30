import { assertTransition } from '../../shared/domain/lifecycle';
import {
  scheduleOnboardingTasks,
  selectRoleTemplate
} from '../../shared/domain/onboarding';
import { conflictError, notFoundError } from '../../shared/errors';
import type { OnboardingTaskRecord } from '../../shared/models';
import type { GenerateOnboardingChecklistOutput } from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import type { OperationHandler } from '../operationService';

/** Materialize the accepted offer's role-specific onboarding checklist. */
export const generateOnboardingChecklist: OperationHandler<
  'generate_onboarding_checklist'
> = (input, context): GenerateOnboardingChecklistOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
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
      `Offer ${offerId} must be accepted before onboarding can be generated`,
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

  const existingTask = [...context.state.onboardingTasks.values()].find(
    (task) => task.offerId === offerId
  );
  if (existingTask !== undefined) {
    throw conflictError(`Onboarding checklist already exists for offer ${offerId}`, {
      recordType: 'Onboarding_Task_Record',
      recordId: existingTask.id,
      field: 'offerId'
    });
  }

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

  // Validate the lifecycle edge before creating any task in the transaction draft.
  assertTransition(application.status, 'onboarding');
  const scheduledTasks = scheduleOnboardingTasks(template, context.state.catalogs.startDate);
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

  return {
    tasks: taskRecords.map(({ id, taskName, dueDate }) => ({
      taskId: id,
      taskName,
      dueDate
    }))
  };
};

export const generateOnboardingChecklistHandler = generateOnboardingChecklist;
export default generateOnboardingChecklist;
