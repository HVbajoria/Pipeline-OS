import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  APPLICATION_STATUSES,
  type ApplicationRecord,
  type CandidateRecord
} from '../src/shared/models';
import { OperationService } from '../src/server/operationService';
import { getCandidateProfile } from '../src/server/operations/getCandidateProfile';
import { createSeed } from '../src/server/seed';
import { createTestContext, PROPERTY_TEST_OPTIONS, TEST_TIMESTAMP } from './factories';

const nonEmptyTextArbitrary = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((value) => value.trim().length > 0);

const candidateDetailsArbitrary = fc.record({
  name: nonEmptyTextArbitrary,
  email: nonEmptyTextArbitrary,
  resumeText: nonEmptyTextArbitrary,
  skills: fc.array(nonEmptyTextArbitrary, { maxLength: 5 }),
  experienceYears: fc.integer({ min: 0, max: 40 }),
  resumeTextHistory: fc.uniqueArray(nonEmptyTextArbitrary, { maxLength: 5 })
});

const applicationDetailsArbitrary = fc.record({
  candidateSelector: fc.nat({ max: 32 }),
  status: fc.constantFrom(...APPLICATION_STATUSES),
  screeningScore: fc.oneof(
    fc.constant(null),
    fc.integer({ min: 0, max: 100 })
  ),
  screeningRationale: fc.oneof(fc.constant(null), nonEmptyTextArbitrary),
  notes: fc.array(
    fc.record({
      author: nonEmptyTextArbitrary,
      text: nonEmptyTextArbitrary,
      at: fc.constant(TEST_TIMESTAMP)
    }),
    { maxLength: 3 }
  ),
  createdAt: fc.constant(TEST_TIMESTAMP)
});

const profileStateArbitrary = fc
  .record({
    targetDetails: candidateDetailsArbitrary,
    otherDetails: fc.array(candidateDetailsArbitrary, {
      minLength: 1,
      maxLength: 5
    }),
    applicationDetails: fc.array(applicationDetailsArbitrary, {
      maxLength: 12
    })
  })
  .map(({ targetDetails, otherDetails, applicationDetails }) => {
    const candidates: CandidateRecord[] = [
      { id: 'candidate-target', ...targetDetails },
      ...otherDetails.map((details, index) => ({
        id: `candidate-other-${index}`,
        ...details
      }))
    ];

    const applications: ApplicationRecord[] = applicationDetails.map(
      ({ candidateSelector, ...details }, index) => ({
        id: `application-${index}`,
        candidateId: candidates[candidateSelector % candidates.length].id,
        jobId: 'job-1',
        ...details
      })
    );

    return {
      target: candidates[0],
      candidates,
      applications
    };
  });

describe('get_candidate_profile property contract', () => {
  it('returns the complete candidate and exactly matching applications', async () => {
    // Feature: pipelineos, Property 7: Candidate profile join completeness
    // **Validates: Requirements 6.1**
    await fc.assert(
      fc.asyncProperty(profileStateArbitrary, async ({ target, candidates, applications }) => {
        const seed = createSeed();
        seed.candidates = new Map(
          candidates.map((candidate) => [candidate.id, candidate])
        );
        seed.applications = new Map(
          applications.map((application) => [application.id, application])
        );

        const { repository, actor } = createTestContext({ seed });
        const service = new OperationService(repository, {
          get_candidate_profile: getCandidateProfile
        });

        const profile = await service.invoke(
          'get_candidate_profile',
          { candidateId: target.id },
          actor
        );
        const expectedApplications = applications.filter(
          (application) => application.candidateId === target.id
        );

        expect(profile).toEqual({
          ...target,
          applicationHistory: expectedApplications
        });
        expect(profile.applicationHistory).toHaveLength(expectedApplications.length);
      }),
      PROPERTY_TEST_OPTIONS
    );
  });
});
