import type {
  ActivityLogEntry,
  ActivityTrace,
  ApplicationRecord,
  ApplicationStatus,
  ApprovalCardStatus,
  ApprovalCardSummary,
  JsonObject,
  Timestamp
} from '../shared/models';
import { PipelineError, type PipelineErrorObject } from '../shared/errors';
import type {
  CandidateComparison,
  CompareCandidatesOutput,
  GetRecruitingWorkflowStatusOutput,
  WorkflowApplicationSummary
} from '../shared/operations';
import { MAX_TRACE_SPANS } from '../shared/operations';

/** The persisted lifecycle columns used by the recruiter Kanban. */
export const KANBAN_STATUSES: readonly ApplicationStatus[] = [
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
];

export interface KanbanColumn {
  status: ApplicationStatus;
  label: string;
  applications: ApplicationRecord[];
}

function labelForStatus(status: ApplicationStatus): string {
  return status.replaceAll('_', ' ');
}

/** Place every application in exactly one persisted-status column. */
export function projectKanban(
  applications: readonly ApplicationRecord[]
): KanbanColumn[] {
  return KANBAN_STATUSES.map((status) => ({
    status,
    label: labelForStatus(status),
    applications: applications.filter((application) => application.status === status)
  }));
}

export interface ActivityFeedItem {
  id: string;
  operation: string;
  toolName: string;
  actorType: ActivityLogEntry['actorType'];
  actorId: string;
  input: JsonObject;
  output: JsonObject | null;
  error: PipelineErrorObject | null;
  timestamp: Timestamp;
  phase?: ActivityLogEntry['phase'];
  correlationId?: ActivityLogEntry['correlationId'];
  traceId?: ActivityLogEntry['traceId'];
  spanId?: ActivityLogEntry['spanId'];
  parentSpanId?: ActivityLogEntry['parentSpanId'];
  trace?: ActivityTrace;
  traceGroupId?: string;
  stale?: boolean;
  approvalId?: ActivityLogEntry['approvalId'];
  replayed?: boolean;
  originalActivityId?: ActivityLogEntry['originalActivityId'];
  redactions?: string[];
}

function structuredError(value: JsonObject): PipelineErrorObject | null {
  const candidate = value.error;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const error = candidate as Record<string, unknown>;
  if (
    typeof error.code !== 'string' ||
    typeof error.status !== 'number' ||
    typeof error.message !== 'string'
  ) {
    return null;
  }
  return error as unknown as PipelineErrorObject;
}

/** Normalize persisted success/error activity entries for every page/feed. */
export function projectActivityEntry(entry: ActivityLogEntry): ActivityFeedItem {
  const error = structuredError(entry.output);
  const approvalId = approvalIdForActivity(entry);
  return {
    id: entry.id,
    operation: entry.toolName,
    toolName: entry.toolName,
    actorType: entry.actorType,
    actorId: entry.actorId,
    input: entry.input,
    output: error ? null : entry.output,
    error,
    timestamp: entry.timestamp,
    ...(entry.phase === undefined ? {} : { phase: entry.phase }),
    ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
    ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }),
    ...(entry.spanId === undefined ? {} : { spanId: entry.spanId }),
    ...(entry.parentSpanId === undefined ? {} : { parentSpanId: entry.parentSpanId }),
    ...(entry.trace === undefined
      ? {}
      : {
          trace: projectActivityTrace(entry.trace),
          traceGroupId: entry.traceId ?? entry.correlationId ?? entry.id
        }),
    ...(staleApprovalActivity(entry) ? { stale: true } : {}),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(entry.replayed === undefined ? {} : { replayed: entry.replayed }),
    ...(entry.originalActivityId === undefined
      ? {}
      : { originalActivityId: entry.originalActivityId }),
    ...(entry.redactions === undefined ? {} : { redactions: [...entry.redactions] })
  };
}

export function projectActivityFeed(
  entries: readonly ActivityLogEntry[]
): ActivityFeedItem[] {
  return entries.map(projectActivityEntry).reverse();
}

export type ApprovalCardUiState = ApprovalCardStatus | 'stale' | 'replayed';

export interface ApprovalCardViewModel {
  card: ApprovalCardSummary;
  state: ApprovalCardUiState;
  expired: boolean;
  stale: boolean;
  replayed: boolean;
  relatedActivity: ActivityFeedItem[];
}

function approvalIdForActivity(entry: ActivityLogEntry): string | undefined {
  if (entry.approvalId !== undefined) return entry.approvalId;
  const inputApprovalId = entry.input.approvalId;
  if (typeof inputApprovalId === 'string') return inputApprovalId;
  const outputApprovalId = entry.output.approvalId;
  if (typeof outputApprovalId === 'string') return outputApprovalId;
  const error = structuredError(entry.output);
  const errorApprovalId = error?.details?.approvalId;
  return typeof errorApprovalId === 'string' ? errorApprovalId : undefined;
}

function staleApprovalActivity(entry: ActivityLogEntry): boolean {
  const error = structuredError(entry.output);
  const reason = error?.details?.reason;
  return reason === 'stale_revision' || reason === 'entity_changed';
}

function projectActivityTrace(trace: ActivityTrace | undefined): ActivityTrace | undefined {
  if (trace === undefined) return undefined;
  return {
    spans: trace.spans.slice(0, MAX_TRACE_SPANS).map((span) => ({
      ...span,
      ...(span.summary === undefined ? {} : { summary: { ...span.summary } })
    }))
  };
}

function expiredAtOrBefore(expiresAt: Timestamp, now: Timestamp): boolean {
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(now);
  return Number.isFinite(expiry) && Number.isFinite(current) && current >= expiry;
}

/**
 * Project safe approval-card state without adding a client-owned status.
 * `stale` and `replayed` are derived from persisted Activity Feed metadata;
 * the server remains the source of truth for the card's persisted status.
 */
export function projectApprovalCard(
  card: ApprovalCardSummary,
  activityEntries: readonly ActivityLogEntry[] = [],
  now: Timestamp = new Date().toISOString()
): ApprovalCardViewModel {
  const relatedEntries = activityEntries.filter(
    (entry) => approvalIdForActivity(entry) === card.id
  );
  const relatedActivity = relatedEntries.map(projectActivityEntry);
  const replayed = relatedActivity.some(
    (entry) => entry.replayed === true || entry.phase === 'replay'
  );
  const stale = relatedEntries.some((entry) => staleApprovalActivity(entry));
  const expired =
    card.status === 'expired' ||
    ((card.status === 'pending' || card.status === 'approved') &&
      expiredAtOrBefore(card.expiresAt, now));
  const state: ApprovalCardUiState = replayed
    ? 'replayed'
    : stale
      ? 'stale'
      : expired
        ? 'expired'
        : card.status;

  return {
    card,
    state,
    expired,
    stale,
    replayed,
    relatedActivity
  };
}

/** Project the actor-scoped card queue and its persisted interaction markers. */
export function projectApprovalCards(
  cards: readonly ApprovalCardSummary[],
  activityEntries: readonly ActivityLogEntry[] = [],
  now: Timestamp = new Date().toISOString()
): ApprovalCardViewModel[] {
  return cards.map((card) => projectApprovalCard(card, activityEntries, now));
}

/** Safe UI states for canonical read-operation failures. */
export type CanonicalReadErrorState = 'denied' | 'missing' | 'invalid' | 'error';

/** Classify the shared error envelope without changing its server meaning. */
export function classifyCanonicalReadError(error: unknown): CanonicalReadErrorState {
  const pipelineError = PipelineError.from(error);
  if (pipelineError.code === 'FORBIDDEN_ERROR') return 'denied';
  if (pipelineError.code === 'NOT_FOUND_ERROR') return 'missing';
  if (pipelineError.code === 'VALIDATION_ERROR') return 'invalid';
  return 'error';
}

/** Keep denial copy generic while preserving useful non-sensitive server messages. */
export function canonicalReadErrorMessage(
  error: unknown,
  state = classifyCanonicalReadError(error)
): string {
  if (state === 'denied') return 'This actor is not permitted to view this recruiting data.';
  return PipelineError.from(error).message;
}

export interface CandidateComparisonViewModel {
  jobId: CompareCandidatesOutput['jobId'];
  revision: CompareCandidatesOutput['revision'];
  candidates: CandidateComparison[];
}

/**
 * Project the canonical comparison response without sorting, scoring, or
 * deriving recommendations in the browser. The server's returned order and
 * evidence remain authoritative.
 */
export function projectCandidateComparison(
  output: CompareCandidatesOutput
): CandidateComparisonViewModel {
  return {
    jobId: output.jobId,
    revision: output.revision,
    candidates: output.candidates.map((candidate) => ({
      ...candidate,
      scoreBreakdown: {
        requirementMatch: {
          ...candidate.scoreBreakdown.requirementMatch,
          matched: [...candidate.scoreBreakdown.requirementMatch.matched],
          missing: [...candidate.scoreBreakdown.requirementMatch.missing]
        },
        skillOverlap: {
          ...candidate.scoreBreakdown.skillOverlap,
          matched: [...candidate.scoreBreakdown.skillOverlap.matched]
        },
        experienceFit: { ...candidate.scoreBreakdown.experienceFit }
      },
      limitations: [...candidate.limitations]
    }))
  };
}

export interface WorkflowStatusViewModel {
  revision: GetRecruitingWorkflowStatusOutput['revision'];
  scope: GetRecruitingWorkflowStatusOutput['scope'];
  countsByApplicationStatus: GetRecruitingWorkflowStatusOutput['countsByApplicationStatus'];
  applications: WorkflowApplicationSummary[];
  pendingApprovals: GetRecruitingWorkflowStatusOutput['pendingApprovals'];
  blockers: string[];
  nextActions: string[];
  generatedAt: GetRecruitingWorkflowStatusOutput['generatedAt'];
}

/**
 * Project the canonical workflow-status response while preserving server
 * stages, counts, blockers, actions, approval summaries, and revision.
 */
export function projectWorkflowStatus(
  output: GetRecruitingWorkflowStatusOutput
): WorkflowStatusViewModel {
  return {
    revision: output.revision,
    scope: { ...output.scope },
    countsByApplicationStatus: { ...output.countsByApplicationStatus },
    applications: output.applications.map((application) => ({
      ...application,
      blockers: [...application.blockers],
      nextActions: [...application.nextActions]
    })),
    pendingApprovals: output.pendingApprovals.map((card) => ({
      ...card,
      affectedRecords: card.affectedRecords.map((record) => ({ ...record })),
      proposedOutput: { ...card.proposedOutput },
      changeSummary: [...card.changeSummary],
      warnings: [...card.warnings],
      ...(card.blockers === undefined ? {} : { blockers: [...card.blockers] }),
      ...(card.redactions === undefined ? {} : { redactions: [...card.redactions] })
    })),
    blockers: [...output.blockers],
    nextActions: [...output.nextActions],
    generatedAt: output.generatedAt
  };
}
