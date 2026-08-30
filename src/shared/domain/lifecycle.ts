/**
 * The single application-status transition authority.
 *
 * This module has no repository or actor-service dependency.  Services call
 * `assertTransition` before changing an ApplicationRecord so illegal skips,
 * reversals, and terminal-state changes fail before a transaction mutates a
 * draft.
 */

import { conflictError } from '../errors';
import type { ApplicationStatus } from '../models';

/** Roles that may be supplied when a caller wants actor-aware rejection checks. */
export type LifecycleActorRole =
  | 'recruiter'
  | 'candidate'
  | 'hiring_manager'
  | 'interviewer'
  | 'agent';

export interface LifecycleTransitionContext {
  /** Optional role metadata; ActorContext intentionally does not require it. */
  actorRole?: LifecycleActorRole;
  /** Explicit escape hatch for a service that has already authorized rejection. */
  allowRecruiterRejection?: boolean;
}

/**
 * Every allowed edge in the application lifecycle.  The arrays are frozen so
 * callers cannot accidentally alter the transition table at runtime.
 */
export const APPLICATION_TRANSITIONS: Readonly<
  Record<ApplicationStatus, readonly ApplicationStatus[]>
> = Object.freeze({
  applied: Object.freeze(['screened', 'rejected'] as ApplicationStatus[]),
  screened: Object.freeze(['interviewing', 'rejected'] as ApplicationStatus[]),
  interviewing: Object.freeze(['offer_sent', 'rejected'] as ApplicationStatus[]),
  offer_sent: Object.freeze(['offer_accepted', 'offer_declined'] as ApplicationStatus[]),
  offer_accepted: Object.freeze(['onboarding'] as ApplicationStatus[]),
  offer_declined: Object.freeze([] as ApplicationStatus[]),
  rejected: Object.freeze([] as ApplicationStatus[]),
  onboarding: Object.freeze([] as ApplicationStatus[])
});

/** Alias used by callers that describe the table as a state machine. */
export const APPLICATION_LIFECYCLE_TRANSITIONS = APPLICATION_TRANSITIONS;
export const LIFECYCLE_TRANSITIONS = APPLICATION_TRANSITIONS;

/** Statuses from which a recruiter may reject an application. */
export const PRE_OFFER_REJECTION_STATUSES: readonly ApplicationStatus[] =
  Object.freeze(['applied', 'screened', 'interviewing']);

/** Terminal outcomes that cannot be changed on the existing application. */
export const TERMINAL_APPLICATION_STATUSES: readonly ApplicationStatus[] =
  Object.freeze(['offer_declined', 'rejected', 'onboarding']);

function hasStatus(status: string): status is ApplicationStatus {
  return Object.prototype.hasOwnProperty.call(APPLICATION_TRANSITIONS, status);
}

function contextAllowsRejection(
  context?: LifecycleTransitionContext
): boolean {
  if (context?.allowRecruiterRejection === false) return false;
  if (context?.actorRole !== undefined) {
    return (
      context.actorRole === 'recruiter' ||
      (context.actorRole === 'agent' && context.allowRecruiterRejection === true)
    );
  }
  return true;
}

/** Return whether a status is one of the recruiter-rejectable pre-offer stages. */
export function isPreOfferStatus(status: ApplicationStatus): boolean {
  return (PRE_OFFER_REJECTION_STATUSES as readonly string[]).includes(status);
}

/** Return whether the status is terminal for the current application record. */
export function isTerminalApplicationStatus(
  status: ApplicationStatus
): boolean {
  return (TERMINAL_APPLICATION_STATUSES as readonly string[]).includes(status);
}

/** Return whether a recruiter-authorized rejection edge is valid. */
export function canRejectApplication(
  from: ApplicationStatus,
  context?: LifecycleTransitionContext
): boolean {
  return isPreOfferStatus(from) && contextAllowsRejection(context);
}

/**
 * Check an application transition without mutating state or throwing.
 * Self-transitions are deliberately false: operations must request a real
 * lifecycle edge rather than silently treating a retry as success.
 */
export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  context?: LifecycleTransitionContext
): boolean {
  if (!hasStatus(from) || !hasStatus(to) || from === to) return false;
  if (to === 'rejected') return canRejectApplication(from, context);
  return APPLICATION_TRANSITIONS[from].includes(to);
}

/**
 * Assert an allowed transition and throw the canonical 409 conflict when it
 * is not permitted.  The error includes both status values for API callers
 * and operation handlers that need to explain the conflict.
 */
export function assertTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  context?: LifecycleTransitionContext
): void {
  if (canTransition(from, to, context)) return;

  throw conflictError(
    `Application cannot transition from "${from}" to "${to}"`,
    {
      recordType: 'ApplicationRecord',
      field: 'status',
      fromStatus: from,
      toStatus: to
    }
  );
}

/** Descriptive alias for service code that prefers the domain name. */
export const assertApplicationTransition = assertTransition;
export const canTransitionApplication = canTransition;
