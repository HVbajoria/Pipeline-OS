/** Pure interview proposal and booking commands shared by low-level and coordinator operations. */

import { conflictError } from '../errors';
import { assertTransition } from './lifecycle';
import { selectTopThreeSlots } from './scheduling';
import type {
  ApplicationRecord,
  InterviewPanel,
  InterviewRecord,
  Timestamp
} from '../models';

export interface InterviewProposalCommandOptions {
  /** Coordinator mode returns an equivalent existing proposal set. */
  reuseExisting?: boolean;
}

export interface InterviewProposalCommandResult {
  commonSlots: Timestamp[];
  records: InterviewRecord[];
  created: InterviewRecord[];
}

export interface InterviewBookingCommandOptions {
  /** Coordinator mode treats an already-booked compatible slot as a no-op. */
  allowAlreadyBooked?: boolean;
  /** Restrict the proposal match to the panel selected by the coordinator. */
  panelId?: string;
}

export interface InterviewBookingCommandResult {
  interview: InterviewRecord;
  alreadyBooked: boolean;
}

function timestampMillis(value: string): number | null {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/** Compare ISO-compatible timestamps by instant while retaining exact strings in outputs. */
export function sameInterviewTimestamp(left: Timestamp, right: Timestamp): boolean {
  if (left === right) return true;
  const leftMillis = timestampMillis(left);
  const rightMillis = timestampMillis(right);
  return leftMillis !== null && leftMillis === rightMillis;
}

export const sameTimestamp = sameInterviewTimestamp;

function compareInterviews(left: InterviewRecord, right: InterviewRecord): number {
  const leftMillis = timestampMillis(left.slot);
  const rightMillis = timestampMillis(right.slot);
  if (leftMillis !== null && rightMillis !== null && leftMillis !== rightMillis) {
    return leftMillis - rightMillis;
  }
  if (leftMillis !== null && rightMillis === null) return -1;
  if (leftMillis === null && rightMillis !== null) return 1;
  return left.id.localeCompare(right.id);
}

function proposalsForApplication(
  interviews: Iterable<InterviewRecord>,
  applicationId: string,
  panelId?: string
): InterviewRecord[] {
  return [...interviews]
    .filter(
      (interview) =>
        interview.applicationId === applicationId &&
        interview.status === 'proposed' &&
        (panelId === undefined || interview.panelId === panelId)
    )
    .sort(compareInterviews);
}

/** Return current proposals in deterministic slot/ID order. */
export function currentInterviewProposals(
  interviews: Iterable<InterviewRecord>,
  applicationId: string,
  panelId?: string
): InterviewRecord[] {
  return proposalsForApplication(interviews, applicationId, panelId);
}

/** Return the current booked/completed interview in deterministic order. */
export function currentBookedInterview(
  interviews: Iterable<InterviewRecord>,
  applicationId: string,
  panelId?: string
): InterviewRecord | undefined {
  return [...interviews]
    .filter(
      (interview) =>
        interview.applicationId === applicationId &&
        (interview.status === 'booked' || interview.status === 'completed') &&
        (panelId === undefined || interview.panelId === panelId)
    )
    .sort(compareInterviews)[0];
}

function equivalentProposalSet(
  existing: readonly InterviewRecord[],
  slots: readonly Timestamp[]
): InterviewRecord[] | undefined {
  if (existing.length !== slots.length) return undefined;

  const unused = [...existing];
  const matched: InterviewRecord[] = [];
  for (const slot of slots) {
    const index = unused.findIndex((interview) =>
      sameInterviewTimestamp(interview.slot, slot)
    );
    if (index < 0) return undefined;
    const [interview] = unused.splice(index, 1);
    if (interview === undefined) return undefined;
    matched.push(interview);
  }
  return matched;
}

/**
 * Materialize the deterministic first-three proposal set on a supplied draft.
 * All compatibility checks happen before the first map write.
 */
export function materializeInterviewProposals(
  application: ApplicationRecord,
  panel: InterviewPanel,
  availableSlots: readonly Timestamp[],
  interviews: Map<string, InterviewRecord>,
  nextId: () => string,
  options: InterviewProposalCommandOptions = {}
): InterviewProposalCommandResult {
  const commonSlots = selectTopThreeSlots(availableSlots);
  const reuseExisting = options.reuseExisting === true;

  if (reuseExisting) {
    const existingForApplication = [...interviews.values()].filter(
      (interview) =>
        interview.applicationId === application.id && interview.status === 'proposed'
    );
    const incompatiblePanel = existingForApplication.find(
      (interview) => interview.panelId !== panel.id
    );
    if (incompatiblePanel !== undefined) {
      throw conflictError(
        `Existing interview proposal ${incompatiblePanel.id} belongs to another panel`,
        {
          recordType: 'Interview_Record',
          recordId: incompatiblePanel.id,
          field: 'panelId'
        }
      );
    }

    const existing = equivalentProposalSet(existingForApplication, commonSlots);
    if (existing !== undefined) {
      return { commonSlots, records: existing, created: [] };
    }
    if (existingForApplication.length > 0) {
      throw conflictError(
        `Existing interview proposals for application ${application.id} do not match current availability`,
        {
          recordType: 'Interview_Record',
          field: 'slot',
          applicationId: application.id
        }
      );
    }
  }

  if (commonSlots.length === 0) {
    return { commonSlots, records: [], created: [] };
  }

  const created: InterviewRecord[] = [];
  for (const slot of commonSlots) {
    let interviewId = nextId();
    while (
      interviews.has(interviewId) ||
      created.some((interview) => interview.id === interviewId)
    ) {
      interviewId = nextId();
    }
    created.push({
      id: interviewId,
      applicationId: application.id,
      panelId: panel.id,
      slot,
      status: 'proposed'
    });
  }

  // Commit the command's domain changes only after every slot and ID is valid.
  for (const interview of created) interviews.set(interview.id, interview);
  return { commonSlots, records: created, created };
}

/**
 * Book a matching proposal, cancel all siblings, and advance the application.
 * The coordinator-only replay branch is read-only and requires the completed
 * state to already be internally consistent.
 */
export function bookInterviewSlot(
  application: ApplicationRecord,
  interviews: Map<string, InterviewRecord>,
  slot: Timestamp,
  options: InterviewBookingCommandOptions = {}
): InterviewBookingCommandResult {
  const panelId = options.panelId;
  const existingBooked = [...interviews.values()]
    .filter(
      (interview) =>
        interview.applicationId === application.id &&
        (interview.status === 'booked' || interview.status === 'completed') &&
        (panelId === undefined || interview.panelId === panelId) &&
        sameInterviewTimestamp(interview.slot, slot)
    )
    .sort(compareInterviews);

  if (options.allowAlreadyBooked === true && existingBooked.length > 0) {
    if (existingBooked.length > 1) {
      throw conflictError(
        `Multiple booked interviews match application ${application.id} and slot ${slot}`,
        {
          recordType: 'Interview_Record',
          field: 'slot',
          applicationId: application.id,
          slot
        }
      );
    }
    if (
      application.status !== 'interviewing' &&
      application.status !== 'offer_sent' &&
      application.status !== 'offer_accepted' &&
      application.status !== 'onboarding'
    ) {
      throw conflictError(
        `Booked interview ${existingBooked[0]!.id} is incompatible with application status ${application.status}`,
        {
          recordType: 'Application_Record',
          recordId: application.id,
          field: 'status',
          status: application.status
        }
      );
    }
    const remainingProposals = proposalsForApplication(
      interviews.values(),
      application.id
    );
    if (remainingProposals.length > 0) {
      throw conflictError(
        `Booked interview ${existingBooked[0]!.id} has uncancelled proposal siblings`,
        {
          recordType: 'Interview_Record',
          recordId: existingBooked[0]!.id,
          field: 'status'
        }
      );
    }
    return { interview: existingBooked[0]!, alreadyBooked: true };
  }

  const matchingProposals = proposalsForApplication(
    interviews.values(),
    application.id,
    panelId
  ).filter((interview) => sameInterviewTimestamp(interview.slot, slot));
  const matchingInterview = matchingProposals[0];
  if (matchingInterview === undefined) {
    throw conflictError(
      `No proposed interview matches application ${application.id} and slot ${slot}`,
      {
        recordType: 'Interview_Record',
        field: 'slot',
        applicationId: application.id,
        slot
      }
    );
  }

  // The lifecycle guard deliberately runs before any record changes.
  assertTransition(application.status, 'interviewing');

  matchingInterview.status = 'booked';
  for (const interview of interviews.values()) {
    if (
      interview.applicationId === application.id &&
      interview.id !== matchingInterview.id &&
      interview.status === 'proposed'
    ) {
      interview.status = 'cancelled';
    }
  }
  application.status = 'interviewing';

  return { interview: matchingInterview, alreadyBooked: false };
}

export const createInterviewProposals = materializeInterviewProposals;
export const bookInterview = bookInterviewSlot;
