import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { calculateScreening } from '../src/shared/domain/scoring';
import type {
  ApplicationRecord,
  CandidateRecord,
  JobRequisition
} from '../src/shared/models';
import { OperationService } from '../src/server/operationService';
import { screenCandidate } from '../src/server/operations/screenCandidate';
import { createSeed } from '../src/server/seed';
import {
  PROPERTY_TEST_OPTIONS,
  TEST_TIMESTAMP,
  createTestContext
} from './factories';

const nonBlankTextArbitrary = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((value) => value.trim().length > 0);

const identifierArbitrary = nonBlankTextArbitrary.map(
  (value) => `fixture-${value}`
);

interface ScreeningGraph {
  candidateId: string;
  jobId: string;
  applicationId: string;
  skills: string[];
  requirements: string[];
  experienceYears: number;
}

const screeningGraphArbitrary: fc.Arbitrary<ScreeningGraph> = fc.record({
  candidateId: identifierArbitrary,
  jobId: identifierArbitrary,
  applicationId: identifierArbitrary,
  skills: fc.array(nonBlankTextArbitrary, { maxLength: 8 }),
  requirements: fc.array(nonBlankTextArbitrary, {
    minLength: 1,
    maxLength: 8
  }),
  experienceYears: fc.integer({ min: 0, max: 40 })
});

function createGraphRecords(graph: ScreeningGraph): {
  candidate: CandidateRecord;
  job: JobRequisition;
  application: ApplicationRecord;
} {
  const candidate: CandidateRecord = {
    id: graph.candidateId,
    name: 'Generated Candidate',
    email: 'generated@example.com',
    resumeText: 'Generated resume',
    skills: graph.skills,
    experienceYears: graph.experienceYears,
    resumeTextHistory: []
  };
  const job: JobRequisition = {
    id: graph.jobId,
    title: 'Generated Role',
    department: 'Engineering',
    requirements: graph.requirements,
    compBand: { min: 100000, max: 200000, currency: 'USD' },
    status: 'open',
    createdBy: 'test-recruiter',
    createdAt: TEST_TIMESTAMP
  };
  const application: ApplicationRecord = {
    id: graph.applicationId,
    candidateId: candidate.id,
    jobId: job.id,
    status: 'applied',
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };

  return { candidate, job, application };
}

describe('screen_candidate Property 9', () => {
  it('persists the reference explainable score and returns the same screened record projection', async () => {
    // Feature: pipelineos, Property 9: Explainable screening score
    // **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
    await fc.assert(
      fc.asyncProperty(screeningGraphArbitrary, async (graph) => {
        const { candidate, job, application } = createGraphRecords(graph);
        const seed = createSeed();
        seed.candidates.set(candidate.id, candidate);
        seed.jobs.set(job.id, job);
        seed.applications.set(application.id, application);

        const { repository, actor } = createTestContext({
          seed,
          timestamp: TEST_TIMESTAMP
        });
        const service = new OperationService(repository, {
          screen_candidate: screenCandidate
        });

        const reference = calculateScreening(candidate, job);
        const output = await service.invoke(
          'screen_candidate',
          { applicationId: application.id },
          actor
        );
        const persisted = repository.read().applications.get(application.id);

        expect(output).toEqual({
          applicationId: application.id,
          screeningScore: reference.score,
          screeningRationale: reference.rationale,
          status: 'screened'
        });
        expect(output.screeningScore).toBeGreaterThanOrEqual(0);
        expect(output.screeningScore).toBeLessThanOrEqual(100);
        expect(output.screeningRationale).toBeTypeOf('string');
        expect(output.screeningRationale.length).toBeGreaterThan(0);

        expect(persisted).toMatchObject({
          id: application.id,
          screeningScore: reference.score,
          screeningRationale: reference.rationale,
          status: 'screened'
        });
        expect(persisted?.screeningScore).toBe(output.screeningScore);
        expect(persisted?.screeningRationale).toBe(output.screeningRationale);
      }),
      PROPERTY_TEST_OPTIONS
    );
  });
});
