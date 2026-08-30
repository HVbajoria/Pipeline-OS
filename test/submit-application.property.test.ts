import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { CandidateId, JobRequisition } from '../src/shared/models';
import { submitApplication } from '../src/server/operations/submitApplication';
import { OperationService } from '../src/server/operationService';
import { createSeed } from '../src/server/seed';
import { createTestContext, assertAsyncProperty } from './factories';

const candidateIdArbitrary = fc.constantFrom<CandidateId>(
  'cand-1',
  'cand-2',
  'cand-3'
);

const resumeTextArbitrary = fc.oneof(
  fc.constant('Experienced backend engineer with 8 years building scalable APIs.'),
  fc.constantFrom(
    'Tailored resume: platform APIs',
    'Tailored resume: distributed systems',
    'Tailored resume: cloud infrastructure',
    'Tailored resume: data services'
  ),
  fc.string({ minLength: 1, maxLength: 80 }).filter(
    (value) => value.trim().length > 0
  )
);

const submissionSequenceArbitrary = fc.array(resumeTextArbitrary, {
  minLength: 0,
  maxLength: 8
});

function addSubmissionJobs(
  seed: ReturnType<typeof createSeed>,
  count: number,
  baseJob: JobRequisition
): string[] {
  return Array.from({ length: count }, (_, index) => {
    const jobId = `resume-history-job-${index}`;
    seed.jobs.set(jobId, {
      ...baseJob,
      id: jobId,
      title: `${baseJob.title} ${index + 1}`
    });
    return jobId;
  });
}

describe('submit_application resume history', () => {
  it('retains distinct tailored resumes without replacing the original resume', async () => {
    // Feature: pipelineos, Property 8: Resume-history distinctness
    // **Validates: Requirements 7.6**
    await assertAsyncProperty(
      fc.asyncProperty(
        candidateIdArbitrary,
        submissionSequenceArbitrary,
        async (candidateId, submittedResumes) => {
          const seed = createSeed();
          const candidate = seed.candidates.get(candidateId);
          const baseJob = seed.jobs.get('job-1');
          if (candidate === undefined || baseJob === undefined) {
            throw new Error('Expected deterministic seed candidate and job');
          }

          const jobIds = addSubmissionJobs(seed, submittedResumes.length, baseJob);
          const { repository, actor } = createTestContext({ seed });
          const service = new OperationService(repository, {
            submit_application: submitApplication
          });

          for (const [index, resumeText] of submittedResumes.entries()) {
            await service.invoke(
              'submit_application',
              {
                candidateId,
                jobId: jobIds[index],
                resumeText
              },
              actor
            );
          }

          const persistedCandidate = repository.read().candidates.get(candidateId);
          if (persistedCandidate === undefined) {
            throw new Error('Expected submitted candidate to remain in state');
          }

          const expectedHistory = new Set(
            submittedResumes.filter((resumeText) => resumeText !== candidate.resumeText)
          );
          const persistedHistory = persistedCandidate.resumeTextHistory;

          expect(persistedCandidate.resumeText).toBe(candidate.resumeText);
          expect(persistedHistory).toHaveLength(new Set(persistedHistory).size);
          expect(new Set(persistedHistory)).toEqual(expectedHistory);
        }
      )
    );
  });
});
