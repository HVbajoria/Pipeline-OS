/** Pure role-template, onboarding-date, and completion calculations. */

import { ValidationError } from '../errors';
import type {
  BackgroundCheckRecord,
  BenefitsEnrollmentRecord,
  JobRequisition,
  OnboardingStatus,
  OnboardingTaskRecord,
  RoleTemplate,
  StartDate,
  Timestamp
} from '../models';

export interface ScheduledOnboardingTask {
  taskName: string;
  dueDate: Timestamp;
}

export interface OnboardingStatusInputs {
  offerId: string;
  backgroundChecks?: readonly BackgroundCheckRecord[];
  benefitsEnrollments?: readonly BenefitsEnrollmentRecord[];
  tasks?: readonly OnboardingTaskRecord[];
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function templateMatchesJob(template: RoleTemplate, job: JobRequisition): boolean {
  const matcher = normalizedText(template.roleMatcher).trim();
  if (!matcher || matcher === 'generic') return false;
  const searchableText = normalizedText(
    [job.title, job.department, ...job.requirements].join(' ')
  );
  return searchableText.includes(matcher);
}

/** Select a role-specific template, falling back to the generic template. */
export function selectRoleTemplate(
  job: JobRequisition,
  templates: readonly RoleTemplate[]
): RoleTemplate | undefined {
  const specific = templates.find((template) => templateMatchesJob(template, job));
  if (specific) return specific;
  return (
    templates.find((template) => normalizedText(template.roleMatcher).trim() === 'generic') ??
    templates[0]
  );
}

export const resolveRoleTemplate = selectRoleTemplate;
export const matchRoleTemplate = selectRoleTemplate;

function dateWithOffset(startDate: StartDate, offsetDays: number): Timestamp {
  const startMillis = Date.parse(startDate);
  if (!Number.isFinite(startMillis)) {
    throw new ValidationError('startDate must be a valid timestamp', {
      field: 'startDate'
    });
  }
  if (!Number.isFinite(offsetDays)) {
    throw new ValidationError('offsetDays must be finite', { field: 'offsetDays' });
  }
  return new Date(startMillis + offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Calculate one task due date relative to the configured start date. */
export function calculateTaskDueDate(
  startDate: StartDate,
  offsetDays: number
): Timestamp {
  return dateWithOffset(startDate, offsetDays);
}

export const addOffsetDays = calculateTaskDueDate;
export const onboardingDueDate = calculateTaskDueDate;

/** Materialize role-template task names and due dates without IDs or state. */
export function scheduleOnboardingTasks(
  template: Pick<RoleTemplate, 'onboardingTasks'>,
  startDate: StartDate
): ScheduledOnboardingTask[] {
  return template.onboardingTasks.map((task) => ({
    taskName: task.taskName,
    dueDate: calculateTaskDueDate(startDate, task.offsetDays)
  }));
}

export const createOnboardingTaskSchedule = scheduleOnboardingTasks;
export const buildOnboardingTasks = scheduleOnboardingTasks;

/** Count completed tasks and total tasks using the normative `complete` status. */
export function calculateTaskCompletion(
  tasks: readonly Pick<OnboardingTaskRecord, 'status'>[]
): { done: number; total: number } {
  return {
    done: tasks.filter((task) => task.status === 'complete').length,
    total: tasks.length
  };
}

export function calculateCompletionPercentage(
  completionOrTasks:
    | { done: number; total: number }
    | readonly Pick<OnboardingTaskRecord, 'status'>[]
): number {
  const completion: { done: number; total: number } =
    'done' in completionOrTasks
      ? completionOrTasks
      : calculateTaskCompletion(completionOrTasks);
  if (completion.total <= 0) return 0;
  const percentage = (completion.done / completion.total) * 100;
  return Math.min(100, Math.max(0, percentage));
}

export const onboardingCompletionPercentage = calculateCompletionPercentage;
export const calculateCompletion = calculateCompletionPercentage;

/**
 * Join post-offer records into the exact onboarding-status contract.  The
 * object overload keeps operation handlers readable while the positional
 * overload is convenient for focused unit tests.
 */
export function calculateOnboardingStatus(
  inputs: OnboardingStatusInputs
): OnboardingStatus;
export function calculateOnboardingStatus(
  offerId: string,
  backgroundChecks: readonly BackgroundCheckRecord[],
  benefitsEnrollments: readonly BenefitsEnrollmentRecord[],
  tasks: readonly OnboardingTaskRecord[]
): OnboardingStatus;
export function calculateOnboardingStatus(
  first: OnboardingStatusInputs | string,
  second?: readonly BackgroundCheckRecord[],
  third?: readonly BenefitsEnrollmentRecord[],
  fourth?: readonly OnboardingTaskRecord[]
): OnboardingStatus {
  const inputs: OnboardingStatusInputs =
    typeof first === 'string'
      ? {
          offerId: first,
          backgroundChecks: second,
          benefitsEnrollments: third,
          tasks: fourth
        }
      : first;
  const backgroundCheck = (inputs.backgroundChecks ?? []).find(
    (record) => record.offerId === inputs.offerId
  );
  const tasks = inputs.tasks ?? [];
  const taskCompletion = calculateTaskCompletion(tasks);
  return {
    backgroundCheckStatus: backgroundCheck?.status ?? null,
    benefitsEnrolled: (inputs.benefitsEnrollments ?? []).some(
      (record) => record.offerId === inputs.offerId
    ),
    taskCompletion,
    completionPercentage: calculateCompletionPercentage(taskCompletion)
  };
}

export const getOnboardingStatus = calculateOnboardingStatus;
