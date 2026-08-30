import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  CandidateRecord,
  ExperienceLevel
} from '../src/shared/models';
import type { SearchCandidatesInput } from '../src/shared/operations';
import { createSeed } from '../src/server/seed';
import { OperationService } from '../src/server/operationService';
import { searchCandidates } from '../src/server/operations/searchCandidates';
import {
  PROPERTY_TEST_OPTIONS,
  createActorContext,
  createTestContext
} from './factories';

const SEARCH_TERMS = [
  'aws',
  'backend',
  'css',
  'django',
  'express',
  'go',
  'javascript',
  'node.js',
  'postgresql',
  'python',
  'react',
  'sql',
  'typescript'
] as const;

const searchTermArbitrary = fc.constantFrom(...SEARCH_TERMS);
const experienceLevelArbitrary = fc.constantFrom<ExperienceLevel>(
  'junior',
  'mid',
  'senior'
);

interface GeneratedCandidateFields {
  skills: string[];
  experienceYears: number;
}

const generatedCandidateFieldsArbitrary = fc.record({
  skills: fc.array(searchTermArbitrary, { maxLength: 8 }),
  experienceYears: fc.integer({ min: 0, max: 20 })
});

const candidateCollectionArbitrary = fc
  .array(generatedCandidateFieldsArbitrary, { maxLength: 25 })
  .map((fields) =>
    fields.map(
      ({ skills, experienceYears }, index): CandidateRecord => ({
        id: `generated-candidate-${index}`,
        name: `Generated Candidate ${index}`,
        email: `candidate-${index}@example.test`,
        resumeText: 'Generated candidate resume',
        skills,
        experienceYears,
        resumeTextHistory: []
      })
    )
  );

const searchInputArbitrary = fc
  .record({
    query: fc.option(
      fc.array(searchTermArbitrary, { maxLength: 6 }).map((terms) => terms.join(' ')),
      { nil: undefined }
    ),
    skills: fc.option(fc.array(searchTermArbitrary, { maxLength: 8 }), {
      nil: undefined
    }),
    experienceLevel: fc.option(experienceLevelArbitrary, { nil: undefined })
  })
  .map(({ query, skills, experienceLevel }): SearchCandidatesInput => {
    const input: SearchCandidatesInput = {};
    if (query !== undefined) input.query = query;
    if (skills !== undefined) input.skills = skills;
    if (experienceLevel !== undefined) input.experienceLevel = experienceLevel;
    return input;
  });

/** Independent tokenization used as the reference scorer for this property. */
function referenceTokens(
  value: string | readonly string[] | undefined | null
): string[] {
  const values: readonly string[] =
    typeof value === 'string'
      ? [value]
      : value === undefined || value === null
        ? []
        : value;
  const tokens = new Set<string>();

  for (const item of values) {
    const matches = item.normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g);
    for (const token of matches ?? []) tokens.add(token);
  }

  return [...tokens];
}

function referenceExperienceLevel(experienceYears: number): ExperienceLevel {
  if (experienceYears < 3) return 'junior';
  if (experienceYears < 6) return 'mid';
  return 'senior';
}

/** Compute the normative Jaccard-plus-experience score without calling production scoring code. */
function referenceMatchScore(
  candidate: Pick<CandidateRecord, 'skills' | 'experienceYears'>,
  input: SearchCandidatesInput
): number {
  const queryTokens = referenceTokens([input.query ?? '', ...(input.skills ?? [])]);
  const candidateTokens = referenceTokens(candidate.skills);
  const querySet = new Set(queryTokens);
  const candidateSet = new Set(candidateTokens);
  const union = new Set([...candidateSet, ...querySet]);
  let intersectionSize = 0;

  for (const token of candidateSet) {
    if (querySet.has(token)) intersectionSize += 1;
  }

  const similarity = union.size === 0 ? 0 : intersectionSize / union.size;
  const experienceBonus =
    input.experienceLevel !== undefined &&
    referenceExperienceLevel(candidate.experienceYears) === input.experienceLevel
      ? 10
      : 0;

  return Math.round(Math.min(100, Math.max(0, similarity * 100 + experienceBonus)) * 100) / 100;
}

function referenceResults(
  candidates: readonly CandidateRecord[],
  input: SearchCandidatesInput
): Array<Pick<CandidateRecord, 'id' | 'name'> & { matchScore: number }> {
  return candidates
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      matchScore: referenceMatchScore(candidate, input)
    }))
    .sort(
      (left, right) =>
        right.matchScore - left.matchScore || left.id.localeCompare(right.id)
    )
    .slice(0, 10);
}

describe('Property 6: candidate search ranking and result contract', () => {
  it('ranks generated candidates with the reference score and returns complete results', async () => {
    // Feature: pipelineos, Property 6: Candidate search ranking and result contract
    // **Validates: Requirements 5.1, 5.2, 5.3**
    await fc.assert(
      fc.asyncProperty(
        candidateCollectionArbitrary,
        searchInputArbitrary,
        async (candidates, input) => {
          const seed = createSeed();
          seed.candidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));
          const { repository } = createTestContext({ seed });
          const service = new OperationService(repository, {
            search_candidates: searchCandidates
          });
          const actual = await service.invoke(
            'search_candidates',
            input,
            createActorContext({ actorType: 'agent', actorId: 'property-test-agent' })
          );
          const expected = referenceResults(candidates, input);

          expect(actual.results).toHaveLength(expected.length);
          expect(actual.results.map(({ candidateId, name, matchScore }) => ({
            id: candidateId,
            name,
            matchScore
          }))).toEqual(expected);
          expect(actual.results.length).toBeLessThanOrEqual(10);

          for (const [index, result] of actual.results.entries()) {
            expect(Object.keys(result).sort()).toEqual([
              'candidateId',
              'matchScore',
              'name',
              'rationale'
            ]);
            expect(result.candidateId).toBe(expected[index].id);
            expect(result.name).toBe(expected[index].name);
            expect(result.matchScore).toBeGreaterThanOrEqual(0);
            expect(result.matchScore).toBeLessThanOrEqual(100);
            expect(result.rationale.trim()).not.toBe('');
            expect(result.rationale).toMatch(/skills|experience/i);
            if (index > 0) {
              expect(actual.results[index - 1].matchScore).toBeGreaterThanOrEqual(
                result.matchScore
              );
            }
          }
        }
      ),
      PROPERTY_TEST_OPTIONS
    );
  });
});
