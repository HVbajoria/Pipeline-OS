/** Pure onboarding checklist equivalence and task-transition rules. */

import { conflictError } from '../errors';
import type {
  OnboardingTaskRecord,
  OnboardingTaskStatus,
  Timestamp
} from '../models';
import type { ScheduledOnboardingTask } from './onboarding';

export type OnboardingTaskTransitionKind =
  | 'noop'
  | 'forward'
  | 'correction'
  | 'invalid';

/** Classify the only forward task path and the explicitly authorized reverse path. */
export function taskStatusTransitionKind(
  from: OnboardingTaskStatus,
  to: OnboardingTaskStatus
): OnboardingTaskTransitionKind {
  if (from === to) return 'noop';
  if (
    (from === 'pending' && to === 'in_progress') ||
    (from === 'in_progress' && to === 'complete')
  ) {
    return 'forward';
  }
  if (
    (from === 'in_progress' && to === 'pending') ||
    (from === 'complete' && to === 'in_progress')
  ) {
    return 'correction';
  }
  return 'invalid';
}

export const classifyTaskStatusTransition = taskStatusTransitionKind;
export const canAdvanceTaskStatus = (
  from: OnboardingTaskStatus,
  to: OnboardingTaskStatus
): boolean => taskStatusTransitionKind(from, to) === 'forward';

/** Throw the canonical conflict for a skipped or otherwise invalid transition. */
export function assertTaskStatusTransition(
  task: Pick<OnboardingTaskRecord, 'id' | 'status'>,
  to: OnboardingTaskStatus,
  allowCorrection = false
): OnboardingTaskTransitionKind {
  const kind = taskStatusTransitionKind(task.status, to);
  if (kind === 'invalid') {
    throw conflictError(
      `Onboarding task ${task.id} cannot transition from "${task.status}" to "${to}"`,
      {
        recordType: 'Onboarding_Task_Record',
        recordId: task.id,
        field: 'status',
        fromStatus: task.status,
        toStatus: to
      }
    );
  }
  if (kind === 'correction' && !allowCorrection) {
    throw conflictError(
      `Onboarding task ${task.id} requires an authorized correction to move from "${task.status}" to "${to}"`,
      {
        recordType: 'Onboarding_Task_Record',
        recordId: task.id,
        field: 'status',
        fromStatus: task.status,
        toStatus: to
      }
    );
  }
  return kind;
}

function sameTimestamp(left: Timestamp, right: Timestamp): boolean {
  if (left === right) return true;
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  return Number.isFinite(leftMillis) && leftMillis === rightMillis;
}

/**
 * Match an existing checklist to a deterministic schedule without considering
 * task IDs or current status. The returned records follow template order.
 */
export function equivalentOnboardingChecklist(
  existing: readonly OnboardingTaskRecord[],
  scheduled: readonly ScheduledOnboardingTask[]
): OnboardingTaskRecord[] | undefined {
  if (existing.length !== scheduled.length) return undefined;

  const unused = [...existing];
  const matched: OnboardingTaskRecord[] = [];
  for (const expected of scheduled) {
    const index = unused.findIndex(
      (task) =>
        task.taskName === expected.taskName &&
        sameTimestamp(task.dueDate, expected.dueDate)
    );
    if (index < 0) return undefined;
    const [task] = unused.splice(index, 1);
    if (task === undefined) return undefined;
    matched.push(task);
  }
  return matched;
}

export const matchEquivalentChecklist = equivalentOnboardingChecklist;
