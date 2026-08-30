import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  ApplicationRecord,
  DateRange,
  InterviewPanel,
  InterviewRecord,
  ScorecardRecord,
  ScorecardRecommendation,
  Timestamp
} from '../src/shared/models';
import { PipelineError } from '../src/shared/errors';
import { OperationService } from '../src/server/operationService';
import { checkInterviewerAvailability } from '../src/server/operations/checkInterviewerAvailability';
import { proposeInterviewSlots } from '../src/server/operations/proposeInterviewSlots';
import { bookInterview } from '../src/server/operations/bookInterview';
import { getInterviewKit } from '../src/server/operations/getInterviewKit';
import { submitInterviewFeedback } from '../src/server/operations/submitInterviewFeedback';
import { getPanelFeedbackSummary } from '../src/server/operations/getPanelFeedbackSummary';
import { createSeed } from '../src/server/seed';
import {
  TEST_TIMESTAMP,
  assertAsyncProperty,
  createActorContext,
  createTestContext
} from './factories';

const SLOT_POOL: readonly Timestamp[] = [
  '2026-09-01T09:00:00Z',
  '2026-09-01T10:00:00Z',
  '2026-09-01T11:00:00Z',
  '2026-09-02T09:00:00Z',
  '2026-09-02T10:00:00Z',
  '2026-09-03T11:00:00Z'
];
const slotArbitrary = fc.constantFrom(...SLOT_POOL);
const recommendationArbitrary = fc.constantFrom<ScorecardRecommendation>(
  'strong_yes',
  'yes',
  'no',
  'strong_no'
);
const scoreArbitrary = fc.integer({ min: 1, max: 5 });
const nonBlankTextArbitrary = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((value) => value.trim().length > 0);

function referenceIntersection(
  calendars: readonly (readonly Timestamp[])[],
  dateRange?: DateRange
): Timestamp[] {
  const [first] = calendars;
  if (first === undefined) return [];

  const start = dateRange === undefined ? Number.NEGATIVE_INFINITY : Date.parse(dateRange.start);
  const end = dateRange === undefined ? Number.POSITIVE_INFINITY : Date.parse(dateRange.end);
  const toTimestampSet = (slots: readonly Timestamp[]) => {
    const unique = new Map<number, Timestamp>();
    for (const slot of slots) {
      const millis = Date.parse(slot);
      if (
        Number.isFinite(millis) &&
        millis >= start &&
        millis < end &&
        !unique.has(millis)
      ) {
        unique.set(millis, slot);
      }
    }
    return unique;
  };

  const sets = calendars.map(toTimestampSet);
  const firstSet = sets[0];
  if (firstSet === undefined || sets.some((set) => set.size === 0)) return [];

  return [...firstSet.entries()]
    .filter(([millis]) => sets.slice(1).every((set) => set.has(millis)))
    .sort(([left], [right]) => left - right)
    .map(([, slot]) => slot);
}

function createPanel(
  calendars: readonly (readonly Timestamp[])[],
  jobId = 'job-1'
): InterviewPanel {
  return {
    id: 'property-panel',
    jobId,
    interviewers: calendars.map((_, index) => ({
      id: `property-interviewer-${index}`,
      name: `Interviewer ${index}`,
      role: 'Interviewer'
    }))
  };
}

function seedWithPanelAndCalendars(
  calendars: readonly (readonly Timestamp[])[],
  application?: ApplicationRecord
) {
  const seed = createSeed();
  const panel = createPanel(calendars);
  seed.panels = new Map([[panel.id, panel]]);
  seed.catalogs.availabilityCalendar = new Map(
    calendars.map((slots, index) => [
      `property-interviewer-${index}`,
      [...slots]
    ])
  );
  if (application !== undefined) {
    seed.applications = new Map([[application.id, application]]);
  }
  return seed;
}

function applicationFixture(status: ApplicationRecord['status'] = 'screened'): ApplicationRecord {
  return {
    id: 'property-application',
    candidateId: 'cand-1',
    jobId: 'job-1',
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

const calendarCollectionArbitrary = fc.array(
  fc.uniqueArray(slotArbitrary, { maxLength: SLOT_POOL.length }),
  { minLength: 3, maxLength: 3 }
);

const AVAILABILITY_SLOT_POOL: readonly Timestamp[] = [
  '2026-08-31T23:00:00Z',
  '2026-09-01T00:00:00Z',
  '2026-09-01T09:00:00Z',
  '2026-09-01T10:00:00Z',
  '2026-09-02T09:00:00Z',
  '2026-09-02T10:00:00Z',
  '2026-09-03T11:00:00Z',
  '2026-09-04T00:00:00Z',
  '2026-09-04T01:00:00Z',
  '2026-09-05T09:00:00Z'
];
const availabilitySlotArbitrary = fc.constantFrom(...AVAILABILITY_SLOT_POOL);
const availabilityRangeBoundaries: readonly Timestamp[] = [
  '2026-08-31T00:00:00Z',
  '2026-09-01T00:00:00Z',
  '2026-09-02T00:00:00Z',
  '2026-09-03T00:00:00Z',
  '2026-09-04T00:00:00Z',
  '2026-09-05T00:00:00Z'
];
const availabilityDateRangeArbitrary = fc
  .integer({ min: 0, max: availabilityRangeBoundaries.length - 2 })
  .chain((startIndex) =>
    fc
      .integer({ min: startIndex + 1, max: availabilityRangeBoundaries.length - 1 })
      .map((endIndex) => ({
        start: availabilityRangeBoundaries[startIndex],
        end: availabilityRangeBoundaries[endIndex]
      }))
  );
const availabilityCalendarCollectionArbitrary = fc.array(
  fc.uniqueArray(availabilitySlotArbitrary, {
    maxLength: AVAILABILITY_SLOT_POOL.length
  }),
  { minLength: 3, maxLength: 3 }
);

describe('Phase B correctness properties', () => {
  it('Property 11: returns the reference intersection of every panel calendar in range', async () => {
    // Feature: pipelineos, Property 11: Common availability intersection
    // **Validates: Requirements 10.1, 10.2**
    await assertAsyncProperty(
      fc.asyncProperty(
        availabilityCalendarCollectionArbitrary,
        availabilityDateRangeArbitrary,
        async (calendars, dateRange) => {
          const seed = seedWithPanelAndCalendars(calendars);
          const { repository, actor } = createTestContext({ seed });
          const service = new OperationService(repository, {
            check_interviewer_availability: checkInterviewerAvailability
          });
          const output = await service.invoke(
            'check_interviewer_availability',
            {
              panelId: 'property-panel',
              dateRange
            },
            actor
          );

          const expected = referenceIntersection(calendars, dateRange);
          expect(output.commonFreeSlots).toEqual(expected);
          expect(output.commonFreeSlots).toEqual(
            [...output.commonFreeSlots].sort(
              (left, right) => Date.parse(left) - Date.parse(right)
            )
          );

          const start = Date.parse(dateRange.start);
          const end = Date.parse(dateRange.end);
          expect(
            output.commonFreeSlots.every((slot) => {
              const millis = Date.parse(slot);
              return Number.isFinite(millis) && millis >= start && millis < end;
            })
          ).toBe(true);
        }
      )
    );
  });

  it('Property 12: selects and materializes exactly the first three common slots', async () => {
    // Feature: pipelineos, Property 12: Proposal selection and materialization
    // **Validates: Requirements 11.1, 11.2, 11.3, 11.4**
    await assertAsyncProperty(
      fc.asyncProperty(calendarCollectionArbitrary, async (calendars) => {
        const application = applicationFixture();
        const seed = seedWithPanelAndCalendars(calendars, application);
        const { repository, actor } = createTestContext({ seed });
        const service = new OperationService(repository, {
          propose_interview_slots: proposeInterviewSlots
        });
        const output = await service.invoke(
          'propose_interview_slots',
          { applicationId: application.id },
          actor
        );

        const expectedSlots = referenceIntersection(calendars).slice(0, 3);
        const persisted = [...repository.read().interviews.values()];
        expect(output.proposedSlots.map(({ slot }) => slot)).toEqual(expectedSlots);
        expect(persisted).toHaveLength(expectedSlots.length);
        expect(persisted.map(({ slot }) => slot)).toEqual(expectedSlots);
        expect(persisted.every((interview) => interview.status === 'proposed')).toBe(true);
        expect(persisted.every((interview) => interview.applicationId === application.id)).toBe(
          true
        );
        expect(persisted.every((interview) => interview.panelId === 'property-panel')).toBe(true);
        expect(output.proposedSlots.every(({ interviewId, slot }) => {
          const record = repository.read().interviews.get(interviewId);
          return record?.slot === slot && record.status === 'proposed';
        })).toBe(true);
      })
    );
  });

  const proposalFixtureArbitrary = fc
    .uniqueArray(slotArbitrary, { minLength: 1, maxLength: SLOT_POOL.length })
    .chain((slots) =>
      fc.record({
        slots: fc.constant(slots),
        selectedIndex: fc.integer({ min: 0, max: slots.length - 1 })
      })
    );

  function seedWithProposals(
    slots: readonly Timestamp[],
    applicationStatus: ApplicationRecord['status'] = 'screened'
  ) {
    const seed = createSeed();
    const application = applicationFixture(applicationStatus);
    seed.applications = new Map([[application.id, application]]);
    seed.interviews = new Map(
      slots.map((slot, index) => {
        const interview: InterviewRecord = {
          id: `property-interview-${index}`,
          applicationId: application.id,
          panelId: 'panel-1',
          slot,
          status: 'proposed'
        };
        return [interview.id, interview];
      })
    );
    return { seed, application };
  }

  it('Property 13: books one proposal, cancels siblings, and advances the application', async () => {
    // Feature: pipelineos, Property 13: Atomic interview booking
    // **Validates: Requirements 12.1, 12.2, 12.3, 12.5**
    await assertAsyncProperty(
      fc.asyncProperty(proposalFixtureArbitrary, async ({ slots, selectedIndex }) => {
        const { seed, application } = seedWithProposals(slots);
        const { repository, actor } = createTestContext({ seed });
        const service = new OperationService(repository, {
          book_interview: bookInterview
        });
        const selectedSlot = slots[selectedIndex];
        const output = await service.invoke(
          'book_interview',
          { applicationId: application.id, slot: selectedSlot },
          actor
        );

        const state = repository.read();
        expect(output).toEqual({
          interviewId: `property-interview-${selectedIndex}`,
          status: 'booked'
        });
        expect(state.applications.get(application.id)?.status).toBe('interviewing');
        for (const interview of state.interviews.values()) {
          expect(interview.status).toBe(
            interview.id === output.interviewId ? 'booked' : 'cancelled'
          );
        }
      })
    );
  });

  it('Property 13: leaves all domain records unchanged for a non-matching slot', async () => {
    // Feature: pipelineos, Property 13: Atomic interview booking
    // **Validates: Requirements 12.1, 12.2, 12.3, 12.5**
    await assertAsyncProperty(
      fc.asyncProperty(
        fc.uniqueArray(slotArbitrary, { minLength: 1, maxLength: SLOT_POOL.length }),
        async (slots) => {
          const { seed, application } = seedWithProposals(slots);
          const { repository, actor } = createTestContext({ seed });
          const service = new OperationService(repository, {
            book_interview: bookInterview
          });
          const before = repository.read();

          let thrown: PipelineError | undefined;
          try {
            await service.invoke(
              'book_interview',
              {
                applicationId: application.id,
                slot: '2026-10-01T10:00:00Z'
              },
              actor
            );
          } catch (error) {
            thrown = PipelineError.from(error);
          }

          expect(thrown?.status).toBe(409);
          const after = repository.read();
          expect(after.applications).toEqual(before.applications);
          expect(after.interviews).toEqual(before.interviews);
          expect(after.scorecards).toEqual(before.scorecards);
        }
      )
    );
  });

  it('Property 14: every seeded role kit has three or four non-empty competencies', async () => {
    // Feature: pipelineos, Property 14: Interview kit structure
    // **Validates: Requirements 13.1, 13.2**
    const templates = createSeed().catalogs.roleTemplates;
    await assertAsyncProperty(
      fc.asyncProperty(
        fc.integer({ min: 0, max: templates.length - 1 }),
        async (templateIndex) => {
          const template = templates[templateIndex];
          const seed = createSeed();
          const isGeneric = template.roleMatcher === 'generic';
          seed.jobs = new Map([
            [
              'property-job',
              {
                ...seed.jobs.get('job-1')!,
                id: 'property-job',
                title: isGeneric ? 'Operations Coordinator' : `${template.roleMatcher} role`,
                department: isGeneric ? 'Operations' : 'Engineering',
                requirements: isGeneric ? ['Communication'] : [template.roleMatcher]
              }
            ]
          ]);
          const { repository, actor } = createTestContext({ seed });
          const service = new OperationService(repository, {
            get_interview_kit: getInterviewKit
          });
          const before = repository.read();
          const output = await service.invoke(
            'get_interview_kit',
            { jobId: 'property-job' },
            actor
          );

          expect(output.competencies.length).toBeGreaterThanOrEqual(3);
          expect(output.competencies.length).toBeLessThanOrEqual(4);
          expect(output.competencies.every((group) => group.name.trim().length > 0)).toBe(true);
          expect(output.competencies.every((group) => group.questions.length >= 1)).toBe(true);
          const after = repository.read();
          expect(after.jobs).toEqual(before.jobs);
          expect(after.interviews).toEqual(before.interviews);
          expect(after.scorecards).toEqual(before.scorecards);
        }
      )
    );
  });

  const scoreMapArbitrary = fc.record({
    design: scoreArbitrary,
    coding: scoreArbitrary,
    collaboration: scoreArbitrary
  });

  const feedbackFixtureArbitrary = fc.record({
    existing: fc.array(
      fc.record({
        recommendation: recommendationArbitrary,
        scores: scoreMapArbitrary,
        status: fc.constantFrom<'booked' | 'completed'>('booked', 'completed')
      }),
      { maxLength: 4 }
    ),
    target: fc.record({
      recommendation: recommendationArbitrary,
      scores: scoreMapArbitrary,
      status: fc.constantFrom<'booked' | 'completed'>('booked', 'completed'),
      interviewer: nonBlankTextArbitrary,
      comments: nonBlankTextArbitrary
    })
  });

  it('Property 15: persists feedback and matches reference averages and tallies', async () => {
    // Feature: pipelineos, Property 15: Feedback creation and aggregation
    // **Validates: Requirements 14.1, 14.2, 14.3, 15.1, 15.2, 15.3, 15.4**
    await assertAsyncProperty(
      fc.asyncProperty(feedbackFixtureArbitrary, async ({ existing, target }) => {
        const seed = createSeed();
        const application = applicationFixture('interviewing');
        seed.applications = new Map([[application.id, application]]);
        const targetInterview: InterviewRecord = {
          id: 'target-interview',
          applicationId: application.id,
          panelId: 'panel-1',
          slot: '2026-09-01T10:00:00Z',
          status: target.status
        };
        const existingInterviews = existing.map((fixture, index): InterviewRecord => ({
          id: `existing-interview-${index}`,
          applicationId: application.id,
          panelId: 'panel-1',
          slot: SLOT_POOL[index + 1] ?? SLOT_POOL[0],
          status: fixture.status
        }));
        seed.interviews = new Map([
          [targetInterview.id, targetInterview],
          ...existingInterviews.map((interview) => [interview.id, interview] as const)
        ]);
        const existingScorecards: ScorecardRecord[] = existing.map((fixture, index) => ({
          id: `existing-scorecard-${index}`,
          interviewId: `existing-interview-${index}`,
          interviewer: `existing-interviewer-${index}`,
          competencyScores: { ...fixture.scores },
          recommendation: fixture.recommendation,
          comments: 'Existing feedback',
          submittedAt: TEST_TIMESTAMP
        }));
        seed.scorecards = new Map(
          existingScorecards.map((scorecard) => [scorecard.id, scorecard])
        );

        const { repository, actor } = createTestContext({ seed });
        const service = new OperationService(repository, {
          submit_interview_feedback: submitInterviewFeedback,
          get_panel_feedback_summary: getPanelFeedbackSummary
        });
        const feedbackInput = {
          interviewId: targetInterview.id,
          interviewer: target.interviewer,
          competencyScores: { ...target.scores },
          recommendation: target.recommendation,
          comments: target.comments
        };
        const feedbackOutput = await service.invoke(
          'submit_interview_feedback',
          feedbackInput,
          actor
        );
        const afterFeedback = repository.read();
        const submitted = afterFeedback.scorecards.get(feedbackOutput.scorecardId);
        const expectedScorecard: ScorecardRecord = {
          id: feedbackOutput.scorecardId,
          interviewId: targetInterview.id,
          interviewer: target.interviewer,
          competencyScores: target.scores,
          recommendation: target.recommendation,
          comments: target.comments,
          submittedAt: TEST_TIMESTAMP
        };
        expect(submitted).toEqual(expectedScorecard);
        expect(afterFeedback.interviews.get(targetInterview.id)?.status).toBe('completed');

        const summary = await service.invoke(
          'get_panel_feedback_summary',
          { applicationId: application.id },
          actor
        );
        const targetScorecard = submitted!;
        const allScorecards = [...existingScorecards, targetScorecard];
        const sums: Record<string, { sum: number; count: number }> = {};
        for (const scorecard of allScorecards) {
          for (const [competency, score] of Object.entries(scorecard.competencyScores)) {
            const current = sums[competency] ?? { sum: 0, count: 0 };
            current.sum += score;
            current.count += 1;
            sums[competency] = current;
          }
        }
        const expectedAverages = Object.fromEntries(
          Object.entries(sums).map(([competency, value]) => [
            competency,
            value.sum / value.count
          ])
        );
        const expectedTally: Partial<Record<ScorecardRecommendation, number>> = {};
        for (const scorecard of allScorecards) {
          expectedTally[scorecard.recommendation] =
            (expectedTally[scorecard.recommendation] ?? 0) + 1;
        }
        expect(summary.averageScores).toEqual(expectedAverages);
        expect(summary.recommendationTally).toEqual(expectedTally);
        expect(summary.scorecards).toEqual(allScorecards);
      })
    );
  });
});
