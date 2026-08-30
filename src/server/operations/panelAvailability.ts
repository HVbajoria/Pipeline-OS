/** Shared panel-calendar resolution used by availability and proposal operations. */

import type {
  DateRange,
  InterviewPanel,
  SharedStateWithCatalogs,
  Timestamp
} from '../../shared/models';
import { intersectAvailability } from '../../shared/domain/scheduling';

/** Intersect the calendars for every interviewer assigned to a panel. */
export function commonFreeSlotsForPanel(
  state: SharedStateWithCatalogs,
  panel: InterviewPanel,
  dateRange: DateRange
): Timestamp[] {
  return intersectAvailability(
    state.catalogs.availabilityCalendar,
    panel.interviewers.map((interviewer) => interviewer.id),
    dateRange
  );
}

/**
 * Proposal selection has no date-range input. Derive the smallest valid range
 * containing every panel calendar slot, then reuse the same pure intersection
 * implementation used by check_interviewer_availability.
 */
export function commonFreeSlotsForPanelCalendars(
  state: SharedStateWithCatalogs,
  panel: InterviewPanel
): Timestamp[] {
  const slots = panel.interviewers.flatMap(
    (interviewer) => state.catalogs.availabilityCalendar.get(interviewer.id) ?? []
  );
  const millis = slots
    .map((slot) => Date.parse(slot))
    .filter((value) => Number.isFinite(value));

  if (millis.length === 0) return [];

  const start = Math.min(...millis);
  const end = Math.max(...millis);
  return commonFreeSlotsForPanel(state, panel, {
    start: new Date(start).toISOString(),
    // The availability domain is half-open; include the latest millisecond.
    end: new Date(end + 1).toISOString()
  });
}
