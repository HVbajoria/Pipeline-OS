/**
 * Pure, snapshot-based recruiting workflow status projection.
 *
 * This module joins the supplied isolated state once and returns only safe,
 * bounded workflow summaries. It has no repository, actor resolver, clock,
 * network, or transport dependency; the server handler supplies visibility
 * sets and the timestamp used for the projection.
 */

import type {
  ApprovalCardRecord,
  ApprovalCardSummary,
  ApplicationRecord,
  ApplicationStatus,
  InterviewPanel,
  InterviewRecord,
  OfferRecord,
  SharedStateWithCatalogs,
  Timestamp
} from '../models';
import {
  APPLICATION_STATUSES
} from '../models';
import type {
  GetRecruitingWorkflowStatusInput,
  GetRecruitingWorkflowStatusOutput,
  RecruitingWorkflowScope,
  WorkflowApplicationSummary,
  WorkflowStatusDetail
} from '../operations';
import {
  MAX_APPROVAL_RECORDS,
  MAX_APPROVAL_SUMMARY_ITEMS,
  MAX_APPROVAL_TEXT_LENGTH,
  MAX_WORKFLOW_STATUS_ITEMS,
  MAX_WORKFLOW_TEXT_LENGTH
} from '../operations';
import { aggregatePanelFeedback } from './feedback';
import { isTerminalApplicationStatus } from './lifecycle';
import { calculateOnboardingStatus } from './onboarding';
import { intersectAvailability } from './scheduling';
import { redactJsonObjectWithMetadata } from './redaction';

export interface WorkflowStatusVisibility {
  /** Omit to allow every application in a trusted/legacy read. */
  applicationIds?: readonly string[];
  /** Omit to allow every pending approval in a trusted/legacy read. */
  approvalIds?: readonly string[];
}

export interface WorkflowStatusCalculationOptions {
  /** Supplied by HandlerContext.now(); pure callers may provide a fixture value. */
  generatedAt?: Timestamp;
  limit?: number;
  detail?: WorkflowStatusDetail;
  visibility?: WorkflowStatusVisibility;
}

const DEFAULT_GENERATED_AT: Timestamp = '1970-01-01T00:00:00.000Z';

function boundedText(value: string, maximum = MAX_WORKFLOW_TEXT_LENGTH): string {
  const text = value.trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1))}…`;
}

function uniqueBounded(values: readonly string[], maximum = MAX_APPROVAL_SUMMARY_ITEMS): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .slice(0, maximum)
    .map((value) => boundedText(value));
}

function sortedValues<T extends { id: string }>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function includedIn(
  allowedIds: readonly string[] | undefined,
  id: string
): boolean {
  return allowedIds === undefined || allowedIds.includes(id);
}

function currentStage(status: ApplicationStatus): string {
  if (isTerminalApplicationStatus(status) && status !== 'onboarding') {
    return 'closed';
  }
  switch (status) {
    case 'applied':
      return 'screening';
    case 'screened':
    case 'interviewing':
      return 'interview';
    case 'offer_sent':
      return 'offer';
    case 'offer_accepted':
    case 'onboarding':
      return 'onboarding';
    case 'offer_declined':
    case 'rejected':
      return 'closed';
    default:
      return 'unknown';
  }
}

export const workflowStageForStatus = currentStage;

function panelForJob(
  state: SharedStateWithCatalogs,
  jobId: string
): InterviewPanel | undefined {
  return sortedValues(state.panels.values()).find((panel) => panel.jobId === jobId);
}

function interviewsForApplication(
  state: SharedStateWithCatalogs,
  applicationId: string
): InterviewRecord[] {
  return sortedValues(
    [...state.interviews.values()].filter(
      (interview) => interview.applicationId === applicationId
    )
  );
}

function offersForApplication(
  state: SharedStateWithCatalogs,
  applicationId: string
): OfferRecord[] {
  return sortedValues(
    [...state.offers.values()].filter((offer) => offer.applicationId === applicationId)
  );
}

function hasCommonPanelAvailability(
  state: SharedStateWithCatalogs,
  panel: InterviewPanel
): boolean {
  const interviewerIds = panel.interviewers.map((interviewer) => interviewer.id);
  if (interviewerIds.length === 0) return false;
  const slots = interviewerIds.flatMap(
    (interviewerId) => state.catalogs.availabilityCalendar.get(interviewerId) ?? []
  );
  const millis = slots
    .map((slot) => Date.parse(slot))
    .filter((value) => Number.isFinite(value));
  if (millis.length === 0) return false;
  const start = Math.min(...millis);
  const end = Math.max(...millis) + 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  try {
    return (
      intersectAvailability(
        state.catalogs.availabilityCalendar,
        interviewerIds,
        {
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString()
        }
      ).length > 0
    );
  } catch {
    return false;
  }
}

function appendInterviewProgress(
  state: SharedStateWithCatalogs,
  application: ApplicationRecord,
  blockers: string[],
  nextActions: string[]
): void {
  const panel = panelForJob(state, application.jobId);
  if (panel === undefined) {
    blockers.push('Interview panel is not configured.');
    nextActions.push('Configure an interview panel.');
    return;
  }

  const interviews = interviewsForApplication(state, application.id);
  const proposed = interviews.filter((interview) => interview.status === 'proposed');
  const booked = interviews.filter((interview) => interview.status === 'booked');
  const completed = interviews.filter((interview) => interview.status === 'completed');
  const scorecards = aggregatePanelFeedback(
    application.id,
    state.interviews,
    state.scorecards
  ).scorecards;

  if (application.status === 'screened') {
    if (proposed.length > 0) {
      nextActions.push('Book an interview slot.');
    } else if (booked.length > 0 || completed.length > 0) {
      nextActions.push(
        scorecards.length === 0
          ? 'Submit interview feedback.'
          : 'Review panel feedback and advance the candidate.'
      );
    } else if (hasCommonPanelAvailability(state, panel)) {
      nextActions.push('Propose interview slots.');
    } else {
      blockers.push('No common interviewer availability is configured.');
      nextActions.push('Review interviewer availability.');
    }
    return;
  }

  if (proposed.length > 0 && booked.length === 0 && completed.length === 0) {
    blockers.push('An interview slot must be booked.');
    nextActions.push('Book an interview slot.');
    return;
  }
  if (booked.length === 0 && completed.length === 0) {
    blockers.push('Booked interview record is missing.');
    nextActions.push('Propose interview slots.');
    return;
  }
  if (scorecards.length === 0) {
    nextActions.push('Submit interview feedback.');
  } else {
    nextActions.push('Generate an offer.');
  }
}

function appendOfferProgress(
  state: SharedStateWithCatalogs,
  application: ApplicationRecord,
  blockers: string[],
  nextActions: string[]
): OfferRecord | undefined {
  const offers = offersForApplication(state, application.id);
  const offer = offers[0];
  if (offer === undefined) {
    blockers.push(
      application.status === 'offer_accepted'
        ? 'Accepted offer record is missing.'
        : 'Offer record is missing.'
    );
    nextActions.push(
      application.status === 'offer_accepted'
        ? 'Verify the accepted offer record.'
        : 'Generate an offer.'
    );
    return undefined;
  }

  if (application.status === 'offer_sent') {
    switch (offer.status) {
      case 'draft':
        blockers.push('Offer has not been sent.');
        nextActions.push('Send the offer.');
        break;
      case 'sent':
        nextActions.push('Await the candidate response.');
        break;
      case 'countered':
        nextActions.push('Review the candidate counteroffer.');
        break;
      case 'accepted':
        blockers.push('Application and offer statuses are out of sync.');
        nextActions.push('Reconcile the application status.');
        break;
      case 'declined':
        blockers.push('Application and offer statuses are out of sync.');
        nextActions.push('Reconcile the application status.');
        break;
    }
  }
  return offer;
}

function appendOnboardingProgress(
  state: SharedStateWithCatalogs,
  application: ApplicationRecord,
  offer: OfferRecord | undefined,
  blockers: string[],
  nextActions: string[]
): void {
  if (offer === undefined) return;
  const status = calculateOnboardingStatus({
    offerId: offer.id,
    backgroundChecks: [...state.backgroundChecks.values()],
    benefitsEnrollments: [...state.benefitsEnrollments.values()],
    tasks: [...state.onboardingTasks.values()]
  });
  const tasks = [...state.onboardingTasks.values()].filter(
    (task) => task.offerId === offer.id
  );

  if (tasks.length === 0) {
    blockers.push('Offer accepted but checklist not generated.');
    nextActions.push('Generate the onboarding checklist.');
    return;
  }
  if (status.backgroundCheckStatus === null) {
    blockers.push('Background check not initiated.');
    nextActions.push('Initiate the background check.');
  } else if (status.backgroundCheckStatus === 'pending') {
    blockers.push('Background check is pending.');
    nextActions.push('Await the background check result.');
  } else if (status.backgroundCheckStatus === 'flagged') {
    blockers.push('Background check is flagged.');
    nextActions.push('Review the background check.');
  }
  if (!status.benefitsEnrolled) {
    blockers.push('Benefits are not enrolled.');
    nextActions.push('Enroll benefits.');
  }
  if (status.taskCompletion.done < status.taskCompletion.total) {
    blockers.push('Onboarding tasks remain incomplete.');
    nextActions.push('Complete the onboarding tasks.');
  }
  if (blockers.length === 0 && nextActions.length === 0) {
    nextActions.push('Confirm onboarding completion.');
  }

  // Keep the application parameter meaningful to callers that inspect this
  // helper while deliberately not copying private offer/task fields to output.
  void application;
}

function applicationSummary(
  state: SharedStateWithCatalogs,
  application: ApplicationRecord
): WorkflowApplicationSummary {
  const blockers: string[] = [];
  const nextActions: string[] = [];
  const candidateExists = state.candidates.has(application.candidateId);
  const jobExists = state.jobs.has(application.jobId);

  if (!candidateExists) blockers.push('Candidate record is missing.');
  if (!jobExists) blockers.push('Job requisition is missing.');

  let offer: OfferRecord | undefined;
  if (candidateExists && jobExists) {
    switch (application.status) {
      case 'applied':
        nextActions.push('Screen the candidate.');
        break;
      case 'screened':
      case 'interviewing':
        appendInterviewProgress(state, application, blockers, nextActions);
        break;
      case 'offer_sent':
        offer = appendOfferProgress(state, application, blockers, nextActions);
        break;
      case 'offer_accepted':
      case 'onboarding':
        offer = appendOfferProgress(state, application, blockers, nextActions);
        appendOnboardingProgress(state, application, offer, blockers, nextActions);
        break;
      case 'offer_declined':
      case 'rejected':
        break;
    }
  }

  return {
    applicationId: application.id,
    candidateId: application.candidateId,
    jobId: application.jobId,
    status: application.status,
    currentStage: currentStage(application.status),
    blockers: uniqueBounded(blockers),
    nextActions: uniqueBounded(nextActions)
  };
}

function safeApprovalSummary(record: ApprovalCardRecord): ApprovalCardSummary {
  const proposed = redactJsonObjectWithMetadata(record.proposedOutput);
  const redactions = [
    'normalizedInput',
    'requestFingerprint',
    'targetFingerprint',
    ...proposed.redactions
  ];
  return {
    id: record.id,
    targetOperation: boundedText(record.targetOperation, 100),
    requestedBy: {
      actorType: record.requestedBy.actorType,
      actorId: boundedText(record.requestedBy.actorId, 128)
    },
    requestedAt: record.requestedAt,
    baseRevision: record.baseRevision,
    affectedRecords: record.affectedRecords.slice(0, MAX_APPROVAL_SUMMARY_ITEMS).map(
      (affected) => ({
        type: boundedText(affected.type, 160),
        id: affected.id,
        effect: affected.effect
      })
    ),
    proposedOutput: proposed.value,
    changeSummary: record.changeSummary
      .slice(0, MAX_APPROVAL_SUMMARY_ITEMS)
      .map((value) => boundedText(value, MAX_APPROVAL_TEXT_LENGTH)),
    warnings: record.warnings
      .slice(0, MAX_APPROVAL_SUMMARY_ITEMS)
      .map((value) => boundedText(value, MAX_APPROVAL_TEXT_LENGTH)),
    ...(record.blockers === undefined
      ? {}
      : { blockers: uniqueBounded(record.blockers) }),
    requiredCapability: boundedText(record.requiredCapability, 160),
    approvalPolicy: record.approvalPolicy,
    ...(record.policyVersion === undefined
      ? {}
      : { policyVersion: boundedText(record.policyVersion, 160) }),
    status: record.status,
    ...(record.approvalNote === undefined
      ? {}
      : { approvalNote: boundedText(record.approvalNote, MAX_APPROVAL_TEXT_LENGTH) }),
    ...(record.rejectionNote === undefined
      ? {}
      : { rejectionNote: boundedText(record.rejectionNote, MAX_APPROVAL_TEXT_LENGTH) }),
    ...(record.approvedBy === undefined
      ? {}
      : {
          approvedBy: {
            actorType: record.approvedBy.actorType,
            actorId: boundedText(record.approvedBy.actorId, 128)
          }
        }),
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.rejectedBy === undefined
      ? {}
      : {
          rejectedBy: {
            actorType: record.rejectedBy.actorType,
            actorId: boundedText(record.rejectedBy.actorId, 128)
          }
        }),
    ...(record.rejectedAt === undefined ? {} : { rejectedAt: record.rejectedAt }),
    expiresAt: record.expiresAt,
    correlationId: record.correlationId,
    traceId: record.traceId,
    ...(record.committedAt === undefined ? {} : { committedAt: record.committedAt }),
    redactions: [...new Set(redactions)]
      .sort()
      .slice(0, MAX_APPROVAL_SUMMARY_ITEMS)
      .map((value) => boundedText(value, 160))
  };
}

/**
 * Calculate a role-filtered status result from exactly the supplied snapshot.
 * Counts cover the visible matching collection; `limit` bounds only rows.
 */
export function calculateRecruitingWorkflowStatus(
  state: SharedStateWithCatalogs,
  input: GetRecruitingWorkflowStatusInput = {},
  options: WorkflowStatusCalculationOptions = {}
): GetRecruitingWorkflowStatusOutput {
  const scope: RecruitingWorkflowScope = {
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.applicationId === undefined ? {} : { applicationId: input.applicationId }),
    ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId })
  };
  const visibleApplicationIds = options.visibility?.applicationIds;
  const applications = sortedValues(state.applications.values()).filter((application) =>
    includedIn(visibleApplicationIds, application.id) &&
    (input.jobId === undefined || application.jobId === input.jobId) &&
    (input.applicationId === undefined || application.id === input.applicationId) &&
    (input.candidateId === undefined || application.candidateId === input.candidateId)
  );

  const countsByApplicationStatus: Record<string, number> = {};
  for (const status of APPLICATION_STATUSES) countsByApplicationStatus[status] = 0;
  for (const application of applications) {
    countsByApplicationStatus[application.status] =
      (countsByApplicationStatus[application.status] ?? 0) + 1;
  }

  const limit = Math.max(
    1,
    Math.min(MAX_WORKFLOW_STATUS_ITEMS, Math.trunc(input.limit ?? options.limit ?? MAX_WORKFLOW_STATUS_ITEMS))
  );
  const summaries = applications.map((application) => applicationSummary(state, application));
  const blockers = uniqueBounded(summaries.flatMap((summary) => summary.blockers));
  const nextActions = uniqueBounded(summaries.flatMap((summary) => summary.nextActions));
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const approvalIds = options.visibility?.approvalIds;
  const pendingApprovals = sortedValues(state.approvalCards.values())
    .filter(
      (record) =>
        record.status === 'pending' &&
        includedIn(approvalIds, record.id) &&
        (Date.parse(record.expiresAt) > Date.parse(generatedAt) ||
          !Number.isFinite(Date.parse(record.expiresAt)) ||
          !Number.isFinite(Date.parse(generatedAt)))
    )
    .slice(0, MAX_APPROVAL_RECORDS)
    .map(safeApprovalSummary);

  // `detail` is intentionally additive: both modes retain the same legacy
  // output shape, while the bounded row list remains useful to every caller.
  void options.detail;

  return {
    revision: state.revision,
    scope,
    countsByApplicationStatus,
    applications: summaries.slice(0, limit),
    pendingApprovals,
    blockers,
    nextActions,
    generatedAt
  };
}

export const getRecruitingWorkflowStatus = calculateRecruitingWorkflowStatus;
export const calculateWorkflowStatus = calculateRecruitingWorkflowStatus;
export { safeApprovalSummary };
