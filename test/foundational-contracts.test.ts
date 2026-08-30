import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  APPLICATION_STATUSES,
  BACKGROUND_CHECK_STATUSES,
  EXPERIENCE_LEVELS,
  INTERVIEW_STATUSES,
  JOB_STATUSES,
  OFFER_DECISIONS,
  OFFER_RESPONSE_STATUSES,
  OFFER_STATUSES,
  ONBOARDING_TASK_STATUSES,
  SCORECARD_RECOMMENDATIONS,
  type ActivityLogEntry,
  type SharedStateWithCatalogs
} from '../src/shared/models';
import {
  OPERATION_IMPLEMENTATION_KEYS,
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  getOperationNames,
  isOperationName,
  type OperationName
} from '../src/shared/operations';
import {
  SEED_INTERVIEW_SLOTS,
  SEED_JOB_ID,
  SEED_PANEL_ID,
  SEED_TIMESTAMP,
  START_DATE,
  createSeed
} from '../src/server/seed';
import { SharedStateRepository } from '../src/server/repository';
import {
  TEST_TIMESTAMP,
  createSeededRepository,
  createTestContext
} from './factories';

const EXPECTED_OPERATION_NAMES = [
  'create_job_requisition',
  'search_candidates',
  'get_candidate_profile',
  'submit_application',
  'screen_candidate',
  'answer_candidate_faq',
  'check_interviewer_availability',
  'propose_interview_slots',
  'book_interview',
  'get_interview_kit',
  'submit_interview_feedback',
  'get_panel_feedback_summary',
  'generate_offer',
  'send_offer',
  'respond_to_offer',
  'initiate_background_check',
  'enroll_benefits',
  'generate_onboarding_checklist',
  'get_onboarding_status'
] as const;

const EXPECTED_INPUT_REQUIRED_FIELDS = {
  create_job_requisition: ['title', 'department', 'requirements', 'compBand'],
  search_candidates: [],
  get_candidate_profile: ['candidateId'],
  submit_application: ['candidateId', 'jobId', 'resumeText'],
  screen_candidate: ['applicationId'],
  answer_candidate_faq: ['jobId', 'question'],
  check_interviewer_availability: ['panelId', 'dateRange'],
  propose_interview_slots: ['applicationId'],
  book_interview: ['applicationId', 'slot'],
  get_interview_kit: ['jobId'],
  submit_interview_feedback: [
    'interviewId',
    'interviewer',
    'competencyScores',
    'recommendation',
    'comments'
  ],
  get_panel_feedback_summary: ['applicationId'],
  generate_offer: ['applicationId', 'compAmount'],
  send_offer: ['offerId'],
  respond_to_offer: ['offerId', 'decision'],
  initiate_background_check: ['offerId'],
  enroll_benefits: ['offerId', 'planSelections'],
  generate_onboarding_checklist: ['offerId'],
  get_onboarding_status: ['offerId']
} as const satisfies Record<OperationName, readonly string[]>;

const EXPECTED_OUTPUT_REQUIRED_FIELDS = {
  create_job_requisition: ['jobId'],
  search_candidates: ['results'],
  get_candidate_profile: [
    'id',
    'name',
    'email',
    'resumeText',
    'skills',
    'experienceYears',
    'resumeTextHistory',
    'applicationHistory'
  ],
  submit_application: ['applicationId', 'status'],
  screen_candidate: [
    'applicationId',
    'screeningScore',
    'screeningRationale',
    'status'
  ],
  answer_candidate_faq: ['answer', 'answeredFromData'],
  check_interviewer_availability: ['commonFreeSlots'],
  propose_interview_slots: ['proposedSlots'],
  book_interview: ['interviewId', 'status'],
  get_interview_kit: ['competencies'],
  submit_interview_feedback: ['scorecardId'],
  get_panel_feedback_summary: [
    'averageScores',
    'recommendationTally',
    'scorecards'
  ],
  generate_offer: ['offerId', 'status'],
  send_offer: ['offerId', 'status'],
  respond_to_offer: ['offerId', 'status'],
  initiate_background_check: ['backgroundCheckId', 'status'],
  enroll_benefits: ['enrollmentId'],
  generate_onboarding_checklist: ['tasks'],
  get_onboarding_status: [
    'backgroundCheckStatus',
    'benefitsEnrolled',
    'taskCompletion',
    'completionPercentage'
  ]
} as const satisfies Record<OperationName, readonly string[]>;

function expectKeys(value: object, expected: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

/**
 * The repository intentionally keeps maps internally. This is the stable
 * array-shaped projection that the state endpoint and client are required to
 * expose, used here to verify that all persisted values survive JSON roundtrip.
 */
function projectState(state: SharedStateWithCatalogs) {
  return {
    revision: state.revision,
    jobs: [...state.jobs.values()],
    candidates: [...state.candidates.values()],
    applications: [...state.applications.values()],
    panels: [...state.panels.values()],
    interviews: [...state.interviews.values()],
    scorecards: [...state.scorecards.values()],
    offers: [...state.offers.values()],
    onboardingTasks: [...state.onboardingTasks.values()],
    backgroundChecks: [...state.backgroundChecks.values()],
    benefitsEnrollments: [...state.benefitsEnrollments.values()],
    activityLog: state.activityLog,
    catalogs: {
      availabilityCalendar: [...state.catalogs.availabilityCalendar.entries()].map(
        ([interviewerId, freeSlots]) => ({ interviewerId, freeSlots })
      ),
      roleTemplates: state.catalogs.roleTemplates,
      planCatalog: state.catalogs.planCatalog,
      startDate: state.catalogs.startDate
    }
  };
}

function expectJsonRoundTrip(value: unknown): void {
  const encoded = JSON.stringify(value);
  expect(encoded).toBeTypeOf('string');
  expect(JSON.parse(encoded as string)).toEqual(value);
}

function domainAndCatalogState(state: SharedStateWithCatalogs) {
  const { revision: _revision, activityLog: _activityLog, ...rest } = state;
  return rest;
}

function activityEntry(
  id: string,
  output: ActivityLogEntry['output'] = { ok: true }
): ActivityLogEntry {
  return {
    id,
    toolName: 'test_operation',
    actorType: 'human_ui',
    actorId: 'test-recruiter',
    input: {
      jobId: SEED_JOB_ID,
      nested: { source: 'contract-test' }
    },
    output,
    timestamp: TEST_TIMESTAMP
  };
}

describe('PipelineOS foundational contracts', () => {
  it('keeps model enum values exact and seeded record fields normative', () => {
    expect(JOB_STATUSES).toEqual(['open', 'paused', 'closed']);
    expect(APPLICATION_STATUSES).toEqual([
      'applied',
      'screened',
      'interviewing',
      'offer_sent',
      'offer_accepted',
      'offer_declined',
      'rejected',
      'onboarding'
    ]);
    expect(INTERVIEW_STATUSES).toEqual([
      'proposed',
      'booked',
      'completed',
      'cancelled'
    ]);
    expect(OFFER_STATUSES).toEqual([
      'draft',
      'sent',
      'accepted',
      'declined',
      'countered'
    ]);
    expect(ONBOARDING_TASK_STATUSES).toEqual([
      'pending',
      'in_progress',
      'complete'
    ]);
    expect(SCORECARD_RECOMMENDATIONS).toEqual([
      'strong_yes',
      'yes',
      'no',
      'strong_no'
    ]);
    expect(BACKGROUND_CHECK_STATUSES).toEqual(['pending', 'clear', 'flagged']);
    expect(ACTOR_TYPES).toEqual(['human_ui', 'agent']);
    expect(OFFER_DECISIONS).toEqual(['accept', 'decline', 'counter']);
    expect(OFFER_RESPONSE_STATUSES).toEqual([
      'accepted',
      'declined',
      'countered'
    ]);
    expect(EXPERIENCE_LEVELS).toEqual(['junior', 'mid', 'senior']);

    const state = createSeed();
    const job = state.jobs.get(SEED_JOB_ID);
    const candidate = state.candidates.get('cand-1');
    const panel = state.panels.get(SEED_PANEL_ID);

    expect(job).toBeDefined();
    expect(candidate).toBeDefined();
    expect(panel).toBeDefined();
    expectKeys(job!, [
      'id',
      'title',
      'department',
      'requirements',
      'compBand',
      'status',
      'createdBy',
      'createdAt'
    ]);
    expectKeys(job!.compBand, ['min', 'max', 'currency']);
    expectKeys(candidate!, [
      'id',
      'name',
      'email',
      'resumeText',
      'skills',
      'experienceYears',
      'resumeTextHistory'
    ]);
    expectKeys(panel!, ['id', 'jobId', 'interviewers']);
    expect(panel!.interviewers).toHaveLength(3);
    for (const interviewer of panel!.interviewers) {
      expectKeys(interviewer, ['id', 'name', 'role']);
    }

    expect(job).toMatchObject({
      id: SEED_JOB_ID,
      status: 'open',
      compBand: { min: 160000, max: 190000, currency: 'USD' },
      createdAt: SEED_TIMESTAMP
    });
    expect(candidate!.resumeTextHistory).toEqual([]);
  });

  it('registers exactly the canonical 19 operations and their required schemas', () => {
    expect(OPERATION_NAMES).toEqual(EXPECTED_OPERATION_NAMES);
    expect(Object.keys(OPERATION_REGISTRY)).toEqual(EXPECTED_OPERATION_NAMES);
    expect(getOperationNames()).toEqual(EXPECTED_OPERATION_NAMES);

    for (const name of EXPECTED_OPERATION_NAMES) {
      const descriptor = OPERATION_REGISTRY[name];
      expect(descriptor.name).toBe(name);
      expect(descriptor.description.trim()).not.toBe('');
      expect(descriptor.implementationKey).toBe(
        OPERATION_IMPLEMENTATION_KEYS[name]
      );
      expect(descriptor.readOnlyHint).toBe(descriptor.readOnly);
      expect(descriptor.annotations).toEqual({
        readOnlyHint: descriptor.readOnly
      });
      expect(descriptor.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false
      });
      expect(descriptor.outputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false
      });
      expect(descriptor.inputSchema.required ?? []).toEqual(
        EXPECTED_INPUT_REQUIRED_FIELDS[name]
      );
      expect(descriptor.outputSchema.required ?? []).toEqual(
        EXPECTED_OUTPUT_REQUIRED_FIELDS[name]
      );
      expectJsonRoundTrip({
        name: descriptor.name,
        description: descriptor.description,
        readOnly: descriptor.readOnly,
        readOnlyHint: descriptor.readOnlyHint,
        annotations: descriptor.annotations,
        implementationKey: descriptor.implementationKey,
        inputSchema: descriptor.inputSchema,
        outputSchema: descriptor.outputSchema
      });
    }

    expect(isOperationName('respond_to_offer')).toBe(true);
    expect(isOperationName('not_a_pipeline_operation')).toBe(false);

    const respondInput = OPERATION_REGISTRY.respond_to_offer.inputSchema;
    const respondOutput = OPERATION_REGISTRY.respond_to_offer.outputSchema;
    expect(respondInput.properties?.decision?.enum).toEqual(OFFER_DECISIONS);
    expect(respondOutput.properties?.status?.enum).toEqual(
      OFFER_RESPONSE_STATUSES
    );
    expect(
      OPERATION_REGISTRY.submit_interview_feedback.inputSchema.properties
        ?.recommendation?.enum
    ).toEqual(SCORECARD_RECOMMENDATIONS);
  });

  it('creates deterministic seed records, calendars, templates, and catalogs', () => {
    const first = createSeed();
    const second = createSeed();

    expect(first).toEqual(second);
    expect(first.revision).toBe(0);
    expect([...first.jobs.keys()]).toEqual([SEED_JOB_ID]);
    expect([...first.candidates.keys()]).toEqual(['cand-1', 'cand-2', 'cand-3']);
    expect([...first.panels.keys()]).toEqual([SEED_PANEL_ID]);
    expect(first.candidates.get('cand-1')?.name).toBe('Alice Chen');
    expect(first.candidates.get('cand-2')?.name).toBe('Bob Smith');
    expect(first.candidates.get('cand-3')?.name).toBe('Charlie Davis');

    expect(first.catalogs.startDate).toBe(START_DATE);
    expect(first.catalogs.planCatalog).toEqual({
      medical: ['medical-basic', 'medical-plus', 'medical-premium'],
      dental: ['dental-basic', 'dental-plus'],
      vision: ['vision-basic', 'vision-plus']
    });
    expect(first.catalogs.roleTemplates.map((template) => template.id)).toEqual([
      'template-engineering',
      'template-generic',
      'template-product'
    ]);
    for (const template of first.catalogs.roleTemplates) {
      expect(template.competencies.length).toBeGreaterThanOrEqual(3);
      expect(template.competencies.length).toBeLessThanOrEqual(4);
      expect(template.competencies.every((group) => group.questions.length > 0)).toBe(
        true
      );
      expect(template.onboardingTasks.length).toBeGreaterThanOrEqual(2);
      expect(template.onboardingTasks.length).toBeLessThanOrEqual(3);
    }

    const panel = first.panels.get(SEED_PANEL_ID)!;
    expect(panel.jobId).toBe(SEED_JOB_ID);
    expect(first.catalogs.availabilityCalendar.get('interviewer-3')).toEqual([
      ...SEED_INTERVIEW_SLOTS
    ]);
    expect(first.catalogs.availabilityCalendar.get('interviewer-1')).toEqual([
      ...SEED_INTERVIEW_SLOTS,
      '2026-09-04T13:00:00Z'
    ]);

    for (const collection of [
      first.applications,
      first.interviews,
      first.scorecards,
      first.offers,
      first.onboardingTasks,
      first.backgroundChecks,
      first.benefitsEnrollments
    ]) {
      expect(collection.size).toBe(0);
    }
    expect(first.activityLog).toEqual([]);
  });

  it('round-trips the array-shaped shared state and catalog projection as JSON', () => {
    const repository = createSeededRepository();
    const entry = activityEntry('activity-json', {
      ok: true,
      nested: { values: ['one', 2, false, null] }
    });
    repository.appendActivity(entry);

    const projection = projectState(repository.read());
    const serialized = JSON.stringify(projection);

    expect(serialized).toBeTypeOf('string');
    expect(JSON.parse(serialized)).toEqual(projection);
    expect(Array.isArray(projection.jobs)).toBe(true);
    expect(Array.isArray(projection.candidates)).toBe(true);
    expect('availabilityCalendar' in projection).toBe(false);
    expect(Array.isArray(projection.catalogs.availabilityCalendar)).toBe(true);
    expect(projection.catalogs.availabilityCalendar).toHaveLength(3);
    expect(projection.activityLog[0]).toEqual(entry);
  });
});

describe('SharedStateRepository isolation and atomicity', () => {
  it('commits a successful mutation and activity entry in exactly one revision', () => {
    const repository = createSeededRepository();
    const events: SharedStateWithCatalogs[] = [];
    const unsubscribe = repository.subscribe((snapshot) => events.push(snapshot));
    const entry = activityEntry('activity-success', { jobId: SEED_JOB_ID });

    const result = repository.transact(
      (draft) => {
        draft.jobs.get(SEED_JOB_ID)!.status = 'paused';
        return { jobId: SEED_JOB_ID };
      },
      entry
    );

    expect(result).toEqual({ jobId: SEED_JOB_ID });
    expect(repository.getRevision()).toBe(1);
    expect(repository.read().jobs.get(SEED_JOB_ID)?.status).toBe('paused');
    expect(repository.read().activityLog).toEqual([entry]);
    expect(events).toHaveLength(1);
    expect(events[0].revision).toBe(1);
    expect(events[0].activityLog).toEqual([entry]);

    unsubscribe();
    repository.transact((draft) => {
      draft.jobs.get(SEED_JOB_ID)!.status = 'closed';
    });
    expect(repository.getRevision()).toBe(2);
    expect(events).toHaveLength(1);
  });

  it('does not commit a failed draft, then permits one separate audit-only revision', () => {
    const repository = createSeededRepository();
    const events: SharedStateWithCatalogs[] = [];
    repository.subscribe((snapshot) => events.push(snapshot));
    const before = repository.read();
    const discardedEntry = activityEntry('activity-discarded');

    expect(() =>
      repository.transact(
        (draft) => {
          draft.jobs.get(SEED_JOB_ID)!.status = 'paused';
          draft.candidates.get('cand-1')!.skills.push('mutated-then-rolled-back');
          throw new Error('abort transaction');
        },
        discardedEntry
      )
    ).toThrow('abort transaction');

    expect(repository.read()).toEqual(before);
    expect(repository.getRevision()).toBe(before.revision);
    expect(events).toHaveLength(0);

    const failedAudit = activityEntry('activity-failed', {
      error: {
        code: 'CONFLICT_ERROR',
        status: 409,
        message: 'Operation conflicts with the current state'
      }
    });
    const audited = repository.appendActivity(failedAudit);

    expect(audited.revision).toBe(before.revision + 1);
    expect(audited.activityLog).toEqual([failedAudit]);
    expect(domainAndCatalogState(audited)).toEqual(
      domainAndCatalogState(before)
    );
    expect(events).toHaveLength(1);
    expect(events[0].revision).toBe(before.revision + 1);
  });

  it('isolates snapshots and reset seeds while keeping revisions monotonic', () => {
    const { repository } = createTestContext();
    repository.transact((draft) => {
      draft.jobs.get(SEED_JOB_ID)!.status = 'paused';
      draft.candidates.get('cand-1')!.resumeTextHistory.push('temporary resume');
    });
    const revisionBeforeReset = repository.getRevision();

    const suppliedSeed = createSeed();
    const resetSnapshot = repository.reset(suppliedSeed);
    expect(resetSnapshot.revision).toBe(revisionBeforeReset + 1);
    expect(resetSnapshot.jobs.get(SEED_JOB_ID)?.status).toBe('open');
    expect(resetSnapshot.candidates.get('cand-1')?.resumeTextHistory).toEqual([]);
    expect(resetSnapshot.activityLog).toEqual([]);

    const expectedSeed = createSeed();
    expect({ ...resetSnapshot, revision: 0 }).toEqual({
      ...expectedSeed,
      revision: 0
    });

    suppliedSeed.jobs.get(SEED_JOB_ID)!.title = 'mutated source seed';
    suppliedSeed.catalogs.roleTemplates[0].competencies[0].questions.push(
      'mutated source question'
    );
    resetSnapshot.jobs.get(SEED_JOB_ID)!.title = 'mutated returned snapshot';
    resetSnapshot.catalogs.roleTemplates[0].competencies[0].questions.push(
      'mutated returned question'
    );

    const isolated = repository.read();
    expect(isolated.jobs.get(SEED_JOB_ID)?.title).toBe('Senior Backend Engineer');
    expect(isolated.catalogs.roleTemplates[0].competencies[0].questions).not.toContain(
      'mutated source question'
    );
    expect(isolated.catalogs.roleTemplates[0].competencies[0].questions).not.toContain(
      'mutated returned question'
    );
  });
});
