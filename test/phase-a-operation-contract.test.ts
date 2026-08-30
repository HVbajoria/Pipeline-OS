import { describe, expect, it } from 'vitest';
import type {
  ApplicationRecord,
  SharedStateWithCatalogs
} from '../src/shared/models';
import { PipelineError } from '../src/shared/errors';
import { calculateScreening } from '../src/shared/domain/scoring';
import { OperationService, type OperationHandlerMap } from '../src/server/operationService';
import { answerCandidateFaq } from '../src/server/operations/answerCandidateFaq';
import { createJobRequisition } from '../src/server/operations/createJobRequisition';
import { getCandidateProfile } from '../src/server/operations/getCandidateProfile';
import { screenCandidate } from '../src/server/operations/screenCandidate';
import { searchCandidates } from '../src/server/operations/searchCandidates';
import { submitApplication } from '../src/server/operations/submitApplication';
import { createSeed } from '../src/server/seed';
import {
  TEST_TIMESTAMP,
  createTestContext
} from './factories';

const phaseAHandlers: OperationHandlerMap = {
  create_job_requisition: createJobRequisition,
  search_candidates: searchCandidates,
  get_candidate_profile: getCandidateProfile,
  submit_application: submitApplication,
  screen_candidate: screenCandidate,
  answer_candidate_faq: answerCandidateFaq
};

const phaseAOperationNames = [
  'create_job_requisition',
  'search_candidates',
  'get_candidate_profile',
  'submit_application',
  'screen_candidate',
  'answer_candidate_faq'
] as const;

function applicationFixture(
  id: string,
  status: ApplicationRecord['status'] = 'applied',
  candidateId = 'cand-1',
  jobId = 'job-1'
): ApplicationRecord {
  return {
    id,
    candidateId,
    jobId,
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

/** Domain collections intentionally exclude revision, activity, and catalogs. */
function domainSnapshot(state: SharedStateWithCatalogs) {
  return {
    jobs: state.jobs,
    candidates: state.candidates,
    applications: state.applications,
    panels: state.panels,
    interviews: state.interviews,
    scorecards: state.scorecards,
    offers: state.offers,
    onboardingTasks: state.onboardingTasks,
    backgroundChecks: state.backgroundChecks,
    benefitsEnrollments: state.benefitsEnrollments
  };
}

function expectSingleAudit(
  repository: ReturnType<typeof createTestContext>['repository'],
  operation: string,
  input: Record<string, unknown>,
  output: unknown
): void {
  const state = repository.read();
  expect(state.activityLog).toHaveLength(1);
  expect(Object.keys(state.activityLog[0]).sort()).toEqual([
    'actorId',
    'actorType',
    'id',
    'input',
    'output',
    'timestamp',
    'toolName'
  ]);
  expect(state.activityLog[0]).toMatchObject({
    toolName: operation,
    actorType: 'human_ui',
    actorId: 'test-recruiter',
    input,
    output,
    timestamp: TEST_TIMESTAMP
  });
  expect(state.revision).toBe(1);
}

function expectFailureAudit(
  repository: ReturnType<typeof createTestContext>['repository'],
  operation: string,
  input: Record<string, unknown>,
  error: PipelineError
): void {
  expectSingleAudit(repository, operation, input, error.toPayload());
}

async function captureError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected operation to fail');
}

describe('Phase A operation contracts, errors, activity, and state', () => {
  it('registers every Phase A name and dispatches create_job_requisition canonically', async () => {
    const { repository, actor } = createTestContext();
    const service = new OperationService(repository, phaseAHandlers);

    expect(Object.keys(phaseAHandlers)).toEqual([...phaseAOperationNames]);
    for (const operationName of phaseAOperationNames) {
      expect(service.hasHandler(operationName)).toBe(true);
    }

    const input = {
      title: 'Platform Engineer',
      department: 'Infrastructure',
      requirements: ['TypeScript', 'Kubernetes'],
      compBand: { min: 120000, max: 150000, currency: 'USD' }
    };
    const output = await service.invoke('create_job_requisition', input, actor);
    const state = repository.read();

    expect(output).toEqual({ jobId: 'job-2' });
    expect(state.jobs.get(output.jobId)).toEqual({
      id: output.jobId,
      title: input.title,
      department: input.department,
      requirements: input.requirements,
      compBand: input.compBand,
      status: 'open',
      createdBy: actor.actorId,
      createdAt: TEST_TIMESTAMP
    });
    expectSingleAudit(repository, 'create_job_requisition', input, output);
  });

  it('returns 400 for invalid requisitions and preserves domain state', async () => {
    const invalidInputs = [
      {
        title: 'Platform Engineer',
        department: 'Infrastructure',
        requirements: [],
        compBand: { min: 120000, max: 150000, currency: 'USD' }
      },
      {
        title: 'Platform Engineer',
        department: 'Infrastructure',
        requirements: ['TypeScript'],
        compBand: { min: 150000, max: 120000, currency: 'USD' }
      }
    ];

    for (const input of invalidInputs) {
      const { repository, actor } = createTestContext();
      const service = new OperationService(repository, phaseAHandlers);
      const before = domainSnapshot(repository.read());
      const error = await captureError(
        service.invoke('create_job_requisition', input, actor)
      );

      expect(error.status).toBe(400);
      expect(domainSnapshot(repository.read())).toEqual(before);
      expectFailureAudit(repository, 'create_job_requisition', input, error);
    }
  });

  it('returns ranked search results read-only with the exact output contract', async () => {
    const { repository, actor } = createTestContext();
    const service = new OperationService(repository, phaseAHandlers);
    const input = { query: 'Node.js' };
    const before = domainSnapshot(repository.read());

    const output = await service.invoke('search_candidates', input, actor);

    expect(output).toEqual({
      results: [
        {
          candidateId: 'cand-1',
          name: 'Alice Chen',
          matchScore: 40,
          rationale: 'Matched skills: node, js; 8 years of experience.'
        },
        {
          candidateId: 'cand-2',
          name: 'Bob Smith',
          matchScore: 0,
          rationale: 'No queried skills matched; 3 years of experience.'
        },
        {
          candidateId: 'cand-3',
          name: 'Charlie Davis',
          matchScore: 0,
          rationale: 'No queried skills matched; 5 years of experience.'
        }
      ]
    });
    expect(domainSnapshot(repository.read())).toEqual(before);
    expectSingleAudit(repository, 'search_candidates', input, output);
  });

  it('returns 400 for malformed search input without mutating domain state', async () => {
    const { repository, actor } = createTestContext();
    const service = new OperationService(repository, phaseAHandlers);
    const input = { query: 42 } as never;
    const before = domainSnapshot(repository.read());

    const error = await captureError(service.invoke('search_candidates', input, actor));

    expect(error.status).toBe(400);
    expect(domainSnapshot(repository.read())).toEqual(before);
    expectFailureAudit(repository, 'search_candidates', input, error);
  });

  it('returns a complete candidate profile read-only with every matching application', async () => {
    const seed = createSeed();
    const matchingApplications = [
      applicationFixture('profile-application-1', 'applied', 'cand-1'),
      applicationFixture('profile-application-2', 'screened', 'cand-1')
    ];
    const unrelatedApplication = applicationFixture(
      'profile-application-other',
      'applied',
      'cand-2'
    );
    seed.applications = new Map([
      ...matchingApplications.map((application) => [application.id, application] as const),
      [unrelatedApplication.id, unrelatedApplication]
    ]);

    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseAHandlers);
    const input = { candidateId: 'cand-1' };
    const before = domainSnapshot(repository.read());
    const candidate = seed.candidates.get('cand-1');

    const output = await service.invoke('get_candidate_profile', input, actor);

    expect(candidate).toBeDefined();
    expect(output).toEqual({
      ...candidate,
      applicationHistory: matchingApplications
    });
    expect(domainSnapshot(repository.read())).toEqual(before);
    expectSingleAudit(repository, 'get_candidate_profile', input, output);
  });

  it('returns 400 and 404 profile errors without changing domain records', async () => {
    const cases = [
      {
        input: { candidateId: '' },
        status: 400 as const
      },
      {
        input: { candidateId: 'missing-candidate' },
        status: 404 as const
      }
    ];

    for (const { input, status } of cases) {
      const { repository, actor } = createTestContext();
      const service = new OperationService(repository, phaseAHandlers);
      const before = domainSnapshot(repository.read());
      const error = await captureError(
        service.invoke('get_candidate_profile', input, actor)
      );

      expect(error.status).toBe(status);
      expect(domainSnapshot(repository.read())).toEqual(before);
      expectFailureAudit(repository, 'get_candidate_profile', input, error);
    }
  });

  it('submits an application with the exact output and persisted record projection', async () => {
    const { repository, actor } = createTestContext();
    const service = new OperationService(repository, phaseAHandlers);
    const input = {
      candidateId: 'cand-1',
      jobId: 'job-1',
      resumeText: 'Tailored resume for platform infrastructure'
    };

    const output = await service.invoke('submit_application', input, actor);
    const state = repository.read();

    expect(output).toEqual({ applicationId: 'application-1', status: 'applied' });
    expect(state.applications.get(output.applicationId)).toEqual({
      id: output.applicationId,
      candidateId: input.candidateId,
      jobId: input.jobId,
      status: 'applied',
      screeningScore: null,
      screeningRationale: null,
      notes: [],
      createdAt: TEST_TIMESTAMP
    });
    expect(state.candidates.get('cand-1')?.resumeTextHistory).toEqual([
      input.resumeText
    ]);
    expectSingleAudit(repository, 'submit_application', input, output);
  });

  it('returns 400, 404, and 409 submission errors atomically', async () => {
    type SubmissionErrorCase = {
      seed: ReturnType<typeof createSeed>;
      input: {
        candidateId: string;
        jobId: string;
        resumeText: string;
      };
      status: 400 | 404 | 409;
    };

    const cases: SubmissionErrorCase[] = [
      {
        seed: createSeed(),
        input: {
          candidateId: 'cand-1',
          jobId: 'job-1',
          resumeText: ''
        },
        status: 400 as const
      },
      {
        seed: createSeed(),
        input: {
          candidateId: 'cand-1',
          jobId: 'missing-job',
          resumeText: 'A valid resume'
        },
        status: 404 as const
      }
    ];

    const duplicateSeed = createSeed();
    duplicateSeed.applications.set(
      'existing-application',
      applicationFixture('existing-application')
    );
    cases.push({
      seed: duplicateSeed,
      input: {
        candidateId: 'cand-1',
        jobId: 'job-1',
        resumeText: 'A valid resume'
      },
      status: 409 as const
    });

    const closedJobSeed = createSeed();
    const closedJob = closedJobSeed.jobs.get('job-1');
    if (closedJob === undefined) throw new Error('Expected seeded job');
    closedJob.status = 'closed';
    cases.push({
      seed: closedJobSeed,
      input: {
        candidateId: 'cand-1',
        jobId: 'job-1',
        resumeText: 'A valid resume'
      },
      status: 409 as const
    });

    for (const { seed, input, status } of cases) {
      const { repository, actor } = createTestContext({ seed });
      const service = new OperationService(repository, phaseAHandlers);
      const before = domainSnapshot(repository.read());
      const error = await captureError(
        service.invoke('submit_application', input, actor)
      );

      expect(error.status).toBe(status);
      expect(domainSnapshot(repository.read())).toEqual(before);
      expectFailureAudit(repository, 'submit_application', input, error);
    }
  });

  it('screens an applied application and returns the persisted explainable score', async () => {
    const seed = createSeed();
    const application = applicationFixture('screening-application');
    seed.applications.set(application.id, application);
    const candidate = seed.candidates.get(application.candidateId);
    const job = seed.jobs.get(application.jobId);
    if (candidate === undefined || job === undefined) {
      throw new Error('Expected seeded candidate and job');
    }

    const { repository, actor } = createTestContext({ seed });
    const service = new OperationService(repository, phaseAHandlers);
    const input = { applicationId: application.id };
    const calculation = calculateScreening(candidate, job);
    const output = await service.invoke('screen_candidate', input, actor);
    const state = repository.read();

    expect(output).toEqual({
      applicationId: application.id,
      screeningScore: calculation.score,
      screeningRationale: calculation.rationale,
      status: 'screened'
    });
    expect(state.applications.get(application.id)).toEqual({
      ...application,
      screeningScore: calculation.score,
      screeningRationale: calculation.rationale,
      status: 'screened'
    });
    expectSingleAudit(repository, 'screen_candidate', input, output);
  });

  it('returns 400, 404, and 409 screening errors without partial mutation', async () => {
    const invalidContext = createTestContext();
    const invalidService = new OperationService(invalidContext.repository, phaseAHandlers);
    const invalidInput = { applicationId: '' };
    const invalidBefore = domainSnapshot(invalidContext.repository.read());
    const invalidError = await captureError(
      invalidService.invoke('screen_candidate', invalidInput, invalidContext.actor)
    );
    expect(invalidError.status).toBe(400);
    expect(domainSnapshot(invalidContext.repository.read())).toEqual(invalidBefore);
    expectFailureAudit(
      invalidContext.repository,
      'screen_candidate',
      invalidInput,
      invalidError
    );

    const missingContext = createTestContext();
    const missingService = new OperationService(missingContext.repository, phaseAHandlers);
    const missingInput = { applicationId: 'missing-application' };
    const missingBefore = domainSnapshot(missingContext.repository.read());
    const missingError = await captureError(
      missingService.invoke('screen_candidate', missingInput, missingContext.actor)
    );
    expect(missingError.status).toBe(404);
    expect(domainSnapshot(missingContext.repository.read())).toEqual(missingBefore);
    expectFailureAudit(
      missingContext.repository,
      'screen_candidate',
      missingInput,
      missingError
    );

    const conflictSeed = createSeed();
    const screenedApplication = applicationFixture('already-screened', 'screened');
    conflictSeed.applications.set(screenedApplication.id, screenedApplication);
    const conflictContext = createTestContext({ seed: conflictSeed });
    const conflictService = new OperationService(conflictContext.repository, phaseAHandlers);
    const conflictInput = { applicationId: screenedApplication.id };
    const conflictBefore = domainSnapshot(conflictContext.repository.read());
    const conflictError = await captureError(
      conflictService.invoke('screen_candidate', conflictInput, conflictContext.actor)
    );
    expect(conflictError.status).toBe(409);
    expect(domainSnapshot(conflictContext.repository.read())).toEqual(conflictBefore);
    expectFailureAudit(
      conflictContext.repository,
      'screen_candidate',
      conflictInput,
      conflictError
    );
  });

  it('answers supported and unsupported FAQs read-only from requisition data', async () => {
    const supportedContext = createTestContext();
    const supportedService = new OperationService(
      supportedContext.repository,
      phaseAHandlers
    );
    const supportedInput = {
      jobId: 'job-1',
      question: 'What is the role title, department, requirements, and salary range?'
    };
    const supportedBefore = domainSnapshot(supportedContext.repository.read());
    const supportedOutput = await supportedService.invoke(
      'answer_candidate_faq',
      supportedInput,
      supportedContext.actor
    );

    expect(supportedOutput).toEqual({
      answer:
        'The role title is "Senior Backend Engineer". The department is "Engineering". ' +
        'The listed requirements are: Node.js, Express, PostgreSQL, AWS. ' +
        'The compensation band is 160000–190000 USD.',
      answeredFromData: true
    });
    expect(domainSnapshot(supportedContext.repository.read())).toEqual(supportedBefore);
    expectSingleAudit(
      supportedContext.repository,
      'answer_candidate_faq',
      supportedInput,
      supportedOutput
    );

    const unsupportedContext = createTestContext();
    const unsupportedService = new OperationService(
      unsupportedContext.repository,
      phaseAHandlers
    );
    const unsupportedInput = {
      jobId: 'job-1',
      question: 'What is the company culture?'
    };
    const unsupportedBefore = domainSnapshot(unsupportedContext.repository.read());
    const unsupportedOutput = await unsupportedService.invoke(
      'answer_candidate_faq',
      unsupportedInput,
      unsupportedContext.actor
    );

    expect(unsupportedOutput).toEqual({
      answer: "I don't have that information in the requisition data.",
      answeredFromData: false
    });
    expect(domainSnapshot(unsupportedContext.repository.read())).toEqual(
      unsupportedBefore
    );
    expectSingleAudit(
      unsupportedContext.repository,
      'answer_candidate_faq',
      unsupportedInput,
      unsupportedOutput
    );
  });

  it('returns 400 and 404 FAQ errors without mutating requisitions', async () => {
    const cases = [
      {
        input: { jobId: 'job-1', question: '' },
        status: 400 as const
      },
      {
        input: { jobId: 'missing-job', question: 'What is the salary range?' },
        status: 404 as const
      }
    ];

    for (const { input, status } of cases) {
      const { repository, actor } = createTestContext();
      const service = new OperationService(repository, phaseAHandlers);
      const before = domainSnapshot(repository.read());
      const error = await captureError(
        service.invoke('answer_candidate_faq', input, actor)
      );

      expect(error.status).toBe(status);
      expect(domainSnapshot(repository.read())).toEqual(before);
      expectFailureAudit(repository, 'answer_candidate_faq', input, error);
    }
  });
});
