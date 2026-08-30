import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ActivityLogEntry, ApplicationRecord, ApplicationStatus } from '../src/shared/models';
import { projectActivityEntry, projectKanban } from '../src/lib/viewModels';
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

const applicationArbitrary = fc.array(fc.constantFrom(...statuses), { maxLength: 16 }).map((values) =>
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

// Feature: pipelineos, Property 21: UI projection mappings
// **Validates: Requirements 25.3, 25.4**
describe('Property 21: UI projection mappings', () => {
  it('places every application in exactly its persisted lifecycle column', () => {
    assertProperty(
      fc.property(applicationArbitrary, (applications) => {
        const columns = projectKanban(applications);
        expect(columns).toHaveLength(statuses.length);
        for (const application of applications) {
          const matches = columns.filter((column) => column.applications.some((item) => item.id === application.id));
          expect(matches).toHaveLength(1);
          expect(matches[0].status).toBe(application.status);
        }
        expect(columns.flatMap((column) => column.applications).map((item) => item.id).sort()).toEqual(
          applications.map((item) => item.id).sort()
        );
      })
    );
  });

  it('retains operation, actor, input, output/error, and timestamp feed fields', () => {
    const entryArbitrary = fc.oneof(
      fc.record({ ok: fc.boolean() }).map((output) => ({
        id: 'activity-success',
        toolName: 'search_candidates',
        actorType: 'human_ui' as const,
        actorId: 'sarah-recruiter',
        input: { query: 'backend' },
        output,
        timestamp: TEST_TIMESTAMP
      } satisfies ActivityLogEntry)),
      fc.record({ message: fc.string({ minLength: 1 }) }).map((details) => ({
        id: 'activity-error',
        toolName: 'screen_candidate',
        actorType: 'agent' as const,
        actorId: 'agent-demo',
        input: { applicationId: 'application-1' },
        output: {
          error: {
            code: 'CONFLICT_ERROR',
            status: 409,
            message: details.message
          }
        },
        timestamp: TEST_TIMESTAMP
      } satisfies ActivityLogEntry))
    );

    assertProperty(
      fc.property(entryArbitrary, (entry) => {
        const item = projectActivityEntry(entry);
        expect(item.operation).toBe(entry.toolName);
        expect(item.toolName).toBe(entry.toolName);
        expect(item.actorType).toBe(entry.actorType);
        expect(item.actorId).toBe(entry.actorId);
        expect(item.input).toEqual(entry.input);
        expect(item.timestamp).toBe(entry.timestamp);
        if ('error' in entry.output) {
          expect(item.error).toEqual(entry.output.error);
          expect(item.output).toBeNull();
        } else {
          expect(item.error).toBeNull();
          expect(item.output).toEqual(entry.output);
        }
      })
    );
  });

  it('uses the repository-wide 100-run property configuration', () => {
    expect(PROPERTY_TEST_OPTIONS.numRuns).toBeGreaterThanOrEqual(100);
  });
});
