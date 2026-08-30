import type {
  ActivityLogEntry,
  ApplicationRecord,
  ApplicationStatus,
  JsonObject,
  Timestamp
} from '../shared/models';
import type { PipelineErrorObject } from '../shared/errors';

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
  return {
    id: entry.id,
    operation: entry.toolName,
    toolName: entry.toolName,
    actorType: entry.actorType,
    actorId: entry.actorId,
    input: entry.input,
    output: error ? null : entry.output,
    error,
    timestamp: entry.timestamp
  };
}

export function projectActivityFeed(
  entries: readonly ActivityLogEntry[]
): ActivityFeedItem[] {
  return entries.map(projectActivityEntry).reverse();
}
