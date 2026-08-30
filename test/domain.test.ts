import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TRANSITIONS,
  assertTransition,
  canRejectApplication,
  canTransition,
  isTerminalApplicationStatus
} from '../src/shared/domain/lifecycle';
import {
  calculateCandidateMatch,
  calculateScreening,
  experienceLevelForYears,
  jaccardSimilarity,
  rankCandidates
} from '../src/shared/domain/scoring';
import {
  UNANSWERED_FAQ_MESSAGE,
  composeFaqAnswer
} from '../src/shared/domain/faq';
import {
  assertValidDateRange,
  findCommonFreeSlots,
  intersectAvailability,
  isValidDateRange,
  selectTopThreeSlots,
  selectTopSlots
} from '../src/shared/domain/scheduling';
import {
  aggregateFeedback,
  averageCompetencyScores,
  joinScorecardsForApplication,
  tallyRecommendations
} from '../src/shared/domain/feedback';
import {
  calculateCompletionPercentage,
  calculateOnboardingStatus,
  calculateTaskCompletion,
  calculateTaskDueDate,
  scheduleOnboardingTasks,
  selectRoleTemplate
} from '../src/shared/domain/onboarding';
import { ConflictError, ValidationError } from '../src/shared/errors';
import type {
  CandidateRecord,
  InterviewRecord,
  JobRequisition,
  RoleTemplate,
  ScorecardRecord
} from '../src/shared/models';

const job: JobRequisition = {
  id: 'job-test',
  title: 'Senior Backend Engineer',
  department: 'Engineering',
  requirements: ['Node.js', '5+ years backend experience', 'AWS'],
  compBand: { min: 150000, max: 190000, currency: 'USD' },
  status: 'open',
  createdBy: 'recruiter-test',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const candidate: CandidateRecord = {
  id: 'candidate-test',
  name: 'Test Candidate',
  email: 'candidate@example.com',
  resumeText: 'Backend engineer',
  skills: ['Node.js', 'AWS', 'backend'],
  experienceYears: 8,
  resumeTextHistory: []
};

const engineeringTemplate: RoleTemplate = {
  id: 'template-engineering',
  roleMatcher: 'engineering',
  competencies: [
    { name: 'System Design', questions: ['How would you scale it?'] },
    { name: 'Coding', questions: ['Explain a recent implementation.'] },
    { name: 'Collaboration', questions: ['How do you resolve disagreements?'] }
  ],
  onboardingTasks: [
    { taskName: 'Provision accounts', offsetDays: 0 },
    { taskName: 'Review policies', offsetDays: 3 }
  ]
};

const genericTemplate: RoleTemplate = {
  id: 'template-generic',
  roleMatcher: 'generic',
  competencies: [
    { name: 'Role Expertise', questions: ['What is your strongest skill?'] }
  ],
  onboardingTasks: [{ taskName: 'Complete paperwork', offsetDays: 0 }]
};

describe('pure PipelineOS domain rules', () => {
  describe('application lifecycle', () => {
    it('allows only the declared forward edges and recruiter pre-offer rejection', () => {
      expect(APPLICATION_TRANSITIONS.applied).toEqual(['screened', 'rejected']);
      expect(canTransition('applied', 'screened')).toBe(true);
      expect(canTransition('screened', 'interviewing')).toBe(true);
      expect(canTransition('interviewing', 'offer_sent')).toBe(true);
      expect(canTransition('offer_sent', 'offer_accepted')).toBe(true);
      expect(canTransition('offer_sent', 'offer_declined')).toBe(true);
      expect(canTransition('offer_accepted', 'onboarding')).toBe(true);
      expect(canRejectApplication('applied')).toBe(true);
      expect(canRejectApplication('interviewing', { actorRole: 'recruiter' })).toBe(
        true
      );
      expect(canTransition('applied', 'rejected', { actorRole: 'candidate' })).toBe(
        false
      );
    });

    it('rejects skipped, reverse, self, and terminal transitions before mutation', () => {
      expect(canTransition('applied', 'interviewing')).toBe(false);
      expect(canTransition('offer_sent', 'screened')).toBe(false);
      expect(canTransition('rejected', 'screened')).toBe(false);
      expect(canTransition('offer_declined', 'offer_accepted')).toBe(false);
      expect(canTransition('applied', 'applied')).toBe(false);
      expect(isTerminalApplicationStatus('rejected')).toBe(true);
      expect(() => assertTransition('applied', 'offer_sent')).toThrow(ConflictError);
      expect(() => assertTransition('applied', 'offer_sent')).toThrow(/cannot transition/);
    });
  });

  describe('candidate scoring and screening', () => {
    it('handles empty Jaccard unions and normalizes punctuation/case', () => {
      expect(jaccardSimilarity([], [])).toBe(0);
      expect(jaccardSimilarity(['Node.js'], ['node', 'js'])).toBe(1);
      expect(experienceLevelForYears(2)).toBe('junior');
      expect(experienceLevelForYears(3)).toBe('mid');
      expect(experienceLevelForYears(6)).toBe('senior');
    });

    it('returns bounded ranked search results with rationale-bearing fields', () => {
      const candidates = Array.from({ length: 11 }, (_, index) => ({
        ...candidate,
        id: `candidate-${index}`,
        name: `Candidate ${index}`
      }));
      const results = rankCandidates(candidates, {
        query: 'Node.js AWS',
        experienceLevel: 'senior'
      });

      expect(results).toHaveLength(10);
      expect(results.every((result) => result.matchScore >= 0 && result.matchScore <= 100)).toBe(
        true
      );
      expect(results.every((result) => result.rationale.length > 0)).toBe(true);
      expect(
        results.every(
          (result, index) =>
            index === 0 || results[index - 1].matchScore >= result.matchScore
        )
      ).toBe(true);
    });

    it('produces an explainable bounded screening score using requirements and experience', () => {
      const calculation = calculateScreening(candidate, job);
      const direct = calculateCandidateMatch(candidate, {
        query: 'Node.js AWS',
        experienceLevel: 'senior'
      });

      expect(calculation.score).toBeGreaterThanOrEqual(0);
      expect(calculation.score).toBeLessThanOrEqual(100);
      expect(calculation.matchedRequirements).toEqual([
        'Node.js',
        '5+ years backend experience',
        'AWS'
      ]);
      expect(calculation.requiredExperienceYears).toBe(5);
      expect(calculation.rationale).toContain('3 of 3');
      expect(direct.matchScore).toBeGreaterThan(0);
      expect(direct.rationale).toContain('Matched skills');
    });
  });

  describe('deterministic FAQ composition', () => {
    it('answers supported requisition questions only from allowed fields', () => {
      const result = composeFaqAnswer(job, 'What department and salary range is this role?');
      expect(result.answeredFromData).toBe(true);
      expect(result.answer).toContain(job.department);
      expect(result.answer).toContain(String(job.compBand.min));
      expect(result.answer).toContain(String(job.compBand.max));
    });

    it('returns an explicit unanswered result for unsupported questions', () => {
      expect(composeFaqAnswer(job, 'What is the company culture and office location?')).toEqual({
        answer: UNANSWERED_FAQ_MESSAGE,
        answeredFromData: false
      });
    });
  });

  describe('availability and proposal slots', () => {
    const range = {
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-02T10:00:00Z'
    } as const;
    const calendars = new Map([
      [
        'one',
        [
          '2026-09-01T10:00:00Z',
          '2026-09-01T11:00:00Z',
          '2026-09-02T10:00:00Z'
        ]
      ],
      ['two', ['2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z']]
    ]);

    it('validates equal/reversed ranges and uses an inclusive-start exclusive-end window', () => {
      expect(isValidDateRange(range)).toBe(true);
      expect(isValidDateRange({ start: range.start, end: range.start })).toBe(false);
      expect(isValidDateRange({ start: range.end, end: range.start })).toBe(false);
      expect(() => assertValidDateRange({ start: range.start, end: range.start })).toThrow(
        ValidationError
      );
      expect(intersectAvailability(calendars, ['one', 'two'], range)).toEqual([
        '2026-09-01T11:00:00Z'
      ]);
    });

    it('intersects all calendars and selects fewer than three available slots safely', () => {
      const directCalendarArrays = [
        ['2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'],
        ['2026-09-01T13:00:00Z']
      ] as const;
      expect(findCommonFreeSlots(directCalendarArrays, range)).toEqual([]);
      expect(selectTopThreeSlots(['2026-09-01T12:00:00Z'])).toEqual([
        '2026-09-01T12:00:00Z'
      ]);
      expect(
        selectTopSlots([
          '2026-09-03T12:00:00Z',
          '2026-09-01T12:00:00Z',
          '2026-09-02T12:00:00Z',
          '2026-09-04T12:00:00Z'
        ])
      ).toEqual([
        '2026-09-01T12:00:00Z',
        '2026-09-02T12:00:00Z',
        '2026-09-03T12:00:00Z'
      ]);
    });
  });

  describe('feedback aggregation', () => {
    const interviews: InterviewRecord[] = [
      {
        id: 'interview-1',
        applicationId: 'application-1',
        panelId: 'panel-1',
        slot: '2026-09-01T10:00:00Z',
        status: 'completed'
      },
      {
        id: 'interview-2',
        applicationId: 'application-2',
        panelId: 'panel-1',
        slot: '2026-09-02T10:00:00Z',
        status: 'completed'
      }
    ];
    const scorecards: ScorecardRecord[] = [
      {
        id: 'scorecard-1',
        interviewId: 'interview-1',
        interviewer: 'interviewer-1',
        competencyScores: { design: 4, coding: 5 },
        recommendation: 'yes',
        comments: 'Good',
        submittedAt: '2026-09-03T10:00:00Z'
      },
      {
        id: 'scorecard-2',
        interviewId: 'interview-1',
        interviewer: 'interviewer-2',
        competencyScores: { design: 2 },
        recommendation: 'no',
        comments: 'Needs growth',
        submittedAt: '2026-09-03T11:00:00Z'
      },
      {
        id: 'scorecard-3',
        interviewId: 'interview-2',
        interviewer: 'interviewer-3',
        competencyScores: { design: 5 },
        recommendation: 'strong_yes',
        comments: 'Strong',
        submittedAt: '2026-09-03T12:00:00Z'
      }
    ];

    it('joins only scorecards for the requested application and handles sparse competencies', () => {
      expect(joinScorecardsForApplication('application-1', interviews, scorecards)).toHaveLength(
        2
      );
      expect(averageCompetencyScores(scorecards.slice(0, 2))).toEqual({
        design: 3,
        coding: 5
      });
      expect(tallyRecommendations(scorecards.slice(0, 2))).toEqual({ yes: 1, no: 1 });
      expect(aggregateFeedback('application-1', interviews, scorecards)).toEqual({
        averageScores: { design: 3, coding: 5 },
        recommendationTally: { yes: 1, no: 1 },
        scorecards: scorecards.slice(0, 2)
      });
    });
  });

  describe('role templates and onboarding calculations', () => {
    const startDate = '2026-09-07T09:00:00Z';

    it('selects a matching role template and falls back to generic', () => {
      expect(selectRoleTemplate(job, [genericTemplate, engineeringTemplate])).toBe(
        engineeringTemplate
      );
      const genericJob = { ...job, title: 'Office Coordinator', department: 'Operations' };
      expect(selectRoleTemplate(genericJob, [engineeringTemplate, genericTemplate])).toBe(
        genericTemplate
      );
    });

    it('calculates task offsets and zero-safe completion percentages', () => {
      expect(calculateTaskDueDate(startDate, 3)).toBe('2026-09-10T09:00:00.000Z');
      expect(scheduleOnboardingTasks(engineeringTemplate, startDate)).toEqual([
        { taskName: 'Provision accounts', dueDate: '2026-09-07T09:00:00.000Z' },
        { taskName: 'Review policies', dueDate: '2026-09-10T09:00:00.000Z' }
      ]);
      expect(calculateTaskCompletion([])).toEqual({ done: 0, total: 0 });
      expect(calculateCompletionPercentage([])).toBe(0);
      expect(
        calculateCompletionPercentage([
          { status: 'complete' },
          { status: 'in_progress' },
          { status: 'complete' }
        ])
      ).toBeCloseTo(66.6666667);
    });

    it('joins onboarding records into status without changing source collections', () => {
      expect(
        calculateOnboardingStatus('offer-1', [
          {
            id: 'check-1',
            offerId: 'offer-1',
            status: 'clear',
            initiatedAt: startDate,
            completedAt: '2026-09-07T09:01:00Z'
          }
        ], [
          {
            id: 'enrollment-1',
            offerId: 'offer-1',
            planSelections: {
              medical: 'medical-basic',
              dental: 'dental-basic',
              vision: 'vision-basic'
            },
            enrolledAt: startDate
          }
        ], [
          { id: 'task-1', offerId: 'offer-1', taskName: 'Paperwork', status: 'complete', dueDate: startDate },
          { id: 'task-2', offerId: 'offer-1', taskName: 'Policies', status: 'pending', dueDate: startDate }
        ])
      ).toEqual({
        backgroundCheckStatus: 'clear',
        benefitsEnrolled: true,
        taskCompletion: { done: 1, total: 2 },
        completionPercentage: 50
      });
    });
  });
});
