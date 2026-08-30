/** Pure availability intersection and interview proposal slot selection. */

import { ValidationError } from '../errors';
import type {
  AvailabilityCalendar,
  DateRange,
  Timestamp
} from '../models';

export type CalendarCollection =
  | AvailabilityCalendar
  | ReadonlyMap<string, readonly Timestamp[]>
  | Readonly<Record<string, readonly Timestamp[]>>
  | readonly (readonly Timestamp[])[];

function isDateRange(value: unknown): value is DateRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    'end' in value &&
    typeof (value as { start?: unknown }).start === 'string' &&
    typeof (value as { end?: unknown }).end === 'string'
  );
}

function timestampMillis(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validate a half-open date range without throwing. */
export function isValidDateRange(dateRange: DateRange): boolean {
  const start = timestampMillis(dateRange.start);
  const end = timestampMillis(dateRange.end);
  return start !== null && end !== null && start < end;
}

export function validateDateRange(dateRange: DateRange): boolean {
  return isValidDateRange(dateRange);
}

/** Throw the shared 400 validation error for malformed or reversed ranges. */
export function assertValidDateRange(dateRange: DateRange): void {
  if (isValidDateRange(dateRange)) return;
  throw new ValidationError(
    'dateRange.start must be earlier than dateRange.end',
    { field: 'dateRange' }
  );
}

export const assertDateRange = assertValidDateRange;

function calendarValues(
  calendar: CalendarCollection,
  interviewerIds?: readonly string[]
): readonly (readonly Timestamp[])[] {
  if (Array.isArray(calendar)) {
    if (interviewerIds === undefined) return calendar;
    return interviewerIds.map((id) => {
      const index = Number(id);
      return Number.isInteger(index) && index >= 0 ? calendar[index] ?? [] : [];
    });
  }

  if (typeof (calendar as { get?: unknown }).get === 'function') {
    const map = calendar as ReadonlyMap<string, readonly Timestamp[]>;
    if (interviewerIds === undefined) return [...map.values()];
    return interviewerIds.map((id) => map.get(id) ?? []);
  }

  const record = calendar as Readonly<Record<string, readonly Timestamp[]>>;
  if (interviewerIds === undefined) return Object.values(record);
  return interviewerIds.map((id) => record[id] ?? []);
}

function uniqueSlotsInRange(
  slots: readonly Timestamp[],
  dateRange: DateRange
): Map<number, Timestamp> {
  const result = new Map<number, Timestamp>();
  const start = Date.parse(dateRange.start);
  const end = Date.parse(dateRange.end);
  for (const slot of slots) {
    const millis = timestampMillis(slot);
    // The requested range is inclusive at start and exclusive at end.
    if (millis !== null && millis >= start && millis < end && !result.has(millis)) {
      result.set(millis, slot);
    }
  }
  return result;
}

/**
 * Intersect every selected interviewer's free calendar inside [start, end).
 * Missing calendars contribute an empty set, and an empty panel has no common
 * slot rather than an unconstrained universe of times.
 */
export function intersectAvailability(
  calendar: CalendarCollection,
  interviewerIds: readonly string[],
  dateRange: DateRange
): Timestamp[] {
  assertValidDateRange(dateRange);
  const ids = [...new Set(interviewerIds)];
  if (ids.length === 0) return [];

  const sets = calendarValues(calendar, ids).map((slots) =>
    uniqueSlotsInRange(slots, dateRange)
  );
  if (sets.some((set) => set.size === 0)) return [];

  const [first, ...remaining] = sets;
  const common: Timestamp[] = [];
  for (const [millis, slot] of first.entries()) {
    if (remaining.every((set) => set.has(millis))) common.push(slot);
  }
  return common.sort((left, right) => Date.parse(left) - Date.parse(right));
}

/**
 * Flexible alias for tests and adapters.  It also accepts a collection of
 * calendar arrays plus a range when interviewer IDs are not needed.
 */
export function findCommonFreeSlots(
  calendar: CalendarCollection,
  interviewerIds: readonly string[],
  dateRange: DateRange
): Timestamp[];
export function findCommonFreeSlots(
  calendars: CalendarCollection,
  dateRange: DateRange
): Timestamp[];
export function findCommonFreeSlots(
  calendar: CalendarCollection,
  interviewerIdsOrRange: readonly string[] | DateRange,
  maybeDateRange?: DateRange
): Timestamp[] {
  if (isDateRange(interviewerIdsOrRange)) {
    const calendars = calendarValues(calendar);
    return intersectAvailability(
      calendars,
      calendars.map((_, index) => String(index)),
      interviewerIdsOrRange
    );
  }
  if (maybeDateRange === undefined) {
    throw new ValidationError('A date range is required', { field: 'dateRange' });
  }
  return intersectAvailability(calendar, interviewerIdsOrRange, maybeDateRange);
}

export const getCommonFreeSlots = intersectAvailability;
export const commonFreeSlots = intersectAvailability;
export const intersectCalendarAvailability = intersectAvailability;

/** Return chronologically ordered, distinct slots capped at the proposal limit. */
export function selectTopSlots(
  slots: readonly Timestamp[],
  limit = 3
): Timestamp[] {
  const safeLimit = Math.max(0, Math.min(3, Math.trunc(limit)));
  const unique = new Map<number, Timestamp>();
  for (const slot of slots) {
    const millis = timestampMillis(slot);
    if (millis !== null && !unique.has(millis)) unique.set(millis, slot);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left - right)
    .slice(0, safeLimit)
    .map(([, slot]) => slot);
}

export function selectTopThreeSlots(slots: readonly Timestamp[]): Timestamp[] {
  return selectTopSlots(slots, 3);
}

export const selectProposalSlots = selectTopThreeSlots;
export const chooseInterviewSlots = selectTopThreeSlots;
