import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ActivityLogEntry, ApplicationRecord, ApplicationStatus } from '../src/shared/models';
import { projectActivityFeed, projectKanban } from '../src/lib/viewModels';
import { assertProperty, PROPERTY_TEST_OPTIONS, TEST_TIMESTAMP } from './factories';

const statuses: readonly ApplicationStatus[] = [
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
];

const nonEmptyTextArbitrary = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((value) => value.trim().length > 0);

const applicationArbitrary = fc
  .array(fc.constantFrom(...statuses), { minLength: 1, maxLength: 16 })
  .map((values) =>
    values.map((status, index): ApplicationRecord => ({
      id: `application-${index}`,
      candidateId: `candidate-${index}`,
      jobId: 'job-1',
      status,
      screeningScore: status === 'applied' ? null : 80,
      screeningRationale: status === 'applied' ? null : 'Matched seeded requirements',
      notes: [],
      createdAt: TEST_TIMESTAMP
    }))
  );

const activityOutputArbitrary = fc.oneof(
  fc.record({
    result: nonEmptyTextArbitrary,
    count: fc.nat({ max: 100 }),
    accepted: fc.boolean()
  }),
  nonEmptyTextArbitrary.map((message) => ({
    error: {
      code: 'VALIDATION_ERROR' as const,
      status: 400 as const,
      message
    }
  })),
  nonEmptyTextArbitrary.map((message) => ({
    error: {
      code: 'NOT_FOUND_ERROR' as const,
      status: 404 as const,
      message
    }
  })),
  nonEmptyTextArbitrary.map((message) => ({
    error: {
      code: 'CONFLICT_ERROR' as const,
      status: 409 as const,
      message
    }
  }))
);

const activityEntryArbitrary: fc.Arbitrary<ActivityLogEntry> = fc.record({
  id: nonEmptyTextArbitrary,
  toolName: nonEmptyTextArbitrary,
  actorType: fc.constantFrom('human_ui' as const, 'agent' as const),
  actorId: nonEmptyTextArbitrary,
  input: fc.oneof(
    fc.record({ query: nonEmptyTextArbitrary }),
    fc.record({ applicationId: nonEmptyTextArbitrary }),
    fc.record({ includeArchived: fc.boolean(), limit: fc.nat({ max: 10 }) })
  ),
  output: activityOutputArbitrary,
  timestamp: nonEmptyTextArbitrary
});

const activityEntriesArbitrary = fc.array(activityEntryArbitrary, {
  minLength: 1,
  maxLength: 16
});

// Feature: pipelineos, Property 21: UI projection mappings
// **Validates: Requirements 25.3, 25.4**
describe('Property 21: UI projection mappings', () => {
  it('maps persisted lifecycle and activity fields through the Kanban and feed view models', () => {
    assertProperty(
      fc.property(
        applicationArbitrary,
        activityEntriesArbitrary,
        (applications, entries) => {
          const columns = projectKanban(applications);
          expect(columns.map((column) => column.status)).toEqual(statuses);
          expect(columns.map((column) => column.label)).toEqual(
            statuses.map((status) => status.replaceAll('_', ' '))
          );

          for (const application of applications) {
            const matchingColumns = columns.filter((column) =>
              column.applications.some((item) => item.id === application.id)
            );
            expect(matchingColumns).toHaveLength(1);
            expect(matchingColumns[0]?.status).toBe(application.status);
          }
          expect(
            columns.flatMap((column) => column.applications).map((item) => item.id).sort()
          ).toEqual(applications.map((item) => item.id).sort());

          const feed = projectActivityFeed(entries);
          expect(feed).toHaveLength(entries.length);
          entries.forEach((entry, index) => {
            const item = feed[entries.length - index - 1];
            const hasStructuredError = Object.prototype.hasOwnProperty.call(
              entry.output,
              'error'
            );

            expect(item).toEqual({
              id: entry.id,
              operation: entry.toolName,
              toolName: entry.toolName,
              actorType: entry.actorType,
              actorId: entry.actorId,
              input: entry.input,
              output: hasStructuredError ? null : entry.output,
              error: hasStructuredError ? entry.output.error : null,
              timestamp: entry.timestamp
            });
          });
        }
      )
    );
  });

  it('uses the repository-wide 100-run property configuration', () => {
    expect(PROPERTY_TEST_OPTIONS.numRuns).toBeGreaterThanOrEqual(100);
  });
});
