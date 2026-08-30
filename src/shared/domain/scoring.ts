/**
 * Deterministic candidate search and screening calculations.
 *
 * Scores are derived only from candidate fields and operation/job inputs.  No
 * network, clock, random source, repository, or LLM is used here so the same
 * calculation can safely back UI, WebMCP, and service operations.
 */

import type {
  CandidateRecord,
  ExperienceLevel,
  JobRequisition
} from '../models';
import type {
  CandidateSearchResult,
  SearchCandidatesInput
} from '../operations';

export const EXPERIENCE_MATCH_BONUS = 10;
export const SCREENING_REQUIREMENTS_WEIGHT = 0.7;
export const SCREENING_EXPERIENCE_WEIGHT = 0.3;

export interface CandidateMatchCalculation {
  matchScore: number;
  rationale: string;
  matchedSkills: string[];
  queryTokens: string[];
  jaccardSimilarity: number;
  experienceBonus: number;
  experienceLevelMatch: boolean | null;
}

export interface ScreeningCalculation {
  score: number;
  rationale: string;
  matchedRequirements: string[];
  totalRequirements: number;
  requirementsMatchPercentage: number;
  requiredExperienceYears: number | null;
  experienceMatchPercentage: number;
}

/** Normalize free text or a list of skill strings into unique lower-case tokens. */
export function normalizeTokens(
  value: string | readonly string[] | undefined | null
): string[] {
  const values =
    typeof value === 'string' || value === undefined || value === null
      ? value === undefined || value === null
        ? []
        : [value]
      : value;
  const tokens = new Set<string>();

  for (const item of values) {
    if (typeof item !== 'string') continue;
    // NFKC makes equivalent unicode forms comparable.  The ASCII token
    // pattern intentionally treats punctuation such as Node.js as separators.
    const matches = item.normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g);
    for (const token of matches ?? []) tokens.add(token);
  }

  return [...tokens];
}

export const normalizeSkillTokens = normalizeTokens;
export const tokenizeQuery = normalizeTokens;

/** Calculate Jaccard similarity, with the empty-union boundary defined as 0. */
export function jaccardSimilarity(
  left: string | readonly string[] | undefined | null,
  right: string | readonly string[] | undefined | null
): number {
  const leftTokens = new Set(normalizeTokens(left));
  const rightTokens = new Set(normalizeTokens(right));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersectionSize += 1;
  }
  return intersectionSize / union.size;
}

export const calculateJaccardSimilarity = jaccardSimilarity;

/** Map the supported experience bands to deterministic year ranges. */
export function experienceLevelForYears(experienceYears: number): ExperienceLevel {
  if (!Number.isFinite(experienceYears) || experienceYears < 3) return 'junior';
  if (experienceYears < 6) return 'mid';
  return 'senior';
}

export function experienceLevelMatches(
  experienceYears: number,
  experienceLevel: ExperienceLevel | undefined
): boolean | null {
  if (experienceLevel === undefined) return null;
  return experienceLevelForYears(experienceYears) === experienceLevel;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function roundedScore(value: number): number {
  return Math.round(clampScore(value) * 100) / 100;
}

function queryTokensFor(input: SearchCandidatesInput): string[] {
  return normalizeTokens([input.query ?? '', ...(input.skills ?? [])]);
}

/** Score one candidate using skill Jaccard overlap plus an optional bonus. */
export function calculateCandidateMatch(
  candidate: Pick<CandidateRecord, 'skills' | 'experienceYears'>,
  input: SearchCandidatesInput
): CandidateMatchCalculation {
  const queryTokens = queryTokensFor(input);
  const candidateTokens = normalizeTokens(candidate.skills);
  const querySet = new Set(queryTokens);
  const matchedSkills = candidateTokens.filter((token) => querySet.has(token));
  const similarity = jaccardSimilarity(candidateTokens, queryTokens);
  const experienceMatch = experienceLevelMatches(
    candidate.experienceYears,
    input.experienceLevel
  );
  const experienceBonus = experienceMatch === true ? EXPERIENCE_MATCH_BONUS : 0;
  const matchScore = roundedScore(similarity * 100 + experienceBonus);

  const skillRationale =
    queryTokens.length === 0
      ? 'No skill terms supplied'
      : matchedSkills.length === 0
        ? 'No queried skills matched'
        : `Matched skills: ${matchedSkills.join(', ')}`;
  const experienceRationale =
    experienceMatch === null
      ? `${candidate.experienceYears} years of experience`
      : experienceMatch
        ? `experience matches the ${input.experienceLevel} level (+${EXPERIENCE_MATCH_BONUS})`
        : `experience does not match the ${input.experienceLevel} level`;

  return {
    matchScore,
    rationale: `${skillRationale}; ${experienceRationale}.`,
    matchedSkills,
    queryTokens,
    jaccardSimilarity: similarity,
    experienceBonus,
    experienceLevelMatch: experienceMatch
  };
}

export const scoreCandidate = calculateCandidateMatch;

/** Return the numeric search score when callers do not need the explanation. */
export function calculateCandidateMatchScore(
  candidate: Pick<CandidateRecord, 'skills' | 'experienceYears'>,
  input: SearchCandidatesInput
): number {
  return calculateCandidateMatch(candidate, input).matchScore;
}

/** Rank every candidate, then return the canonical top-ten search projection. */
export function rankCandidates(
  candidates: readonly CandidateRecord[],
  input: SearchCandidatesInput
): CandidateSearchResult[] {
  return candidates
    .map((candidate) => {
      const calculation = calculateCandidateMatch(candidate, input);
      return {
        candidateId: candidate.id,
        name: candidate.name,
        matchScore: calculation.matchScore,
        rationale: calculation.rationale
      } satisfies CandidateSearchResult;
    })
    .sort(
      (left, right) =>
        right.matchScore - left.matchScore ||
        left.candidateId.localeCompare(right.candidateId)
    )
    .slice(0, 10);
}

export const searchCandidates = rankCandidates;

function requirementTokens(requirement: string): string[] {
  return normalizeTokens(requirement);
}

/**
 * Infer seniority from explicit years or common seniority words in a role
 * requirement.  A missing signal means experience contributes no penalty.
 */
export function inferRequiredExperienceYears(
  requirements: readonly string[]
): number | null {
  let inferred: number | null = null;
  for (const requirement of requirements) {
    const yearsMatches = requirement.match(/(\d+)\s*\+?\s*(?:years?|yrs?)/gi) ?? [];
    for (const match of yearsMatches) {
      const years = Number.parseInt(match, 10);
      if (Number.isFinite(years)) inferred = Math.max(inferred ?? 0, years);
    }

    const tokens = new Set(requirementTokens(requirement));
    if (tokens.has('staff') || tokens.has('principal') || tokens.has('lead')) {
      inferred = Math.max(inferred ?? 0, 8);
    } else if (tokens.has('senior') || tokens.has('sr')) {
      inferred = Math.max(inferred ?? 0, 6);
    } else if (tokens.has('mid') || tokens.has('intermediate')) {
      inferred = Math.max(inferred ?? 0, 3);
    }
  }
  return inferred;
}

function requirementIsMatched(
  requirement: string,
  candidateTokens: Set<string>
): boolean {
  const tokens = requirementTokens(requirement);
  return tokens.some((token) => candidateTokens.has(token));
}

function experienceFitPercentage(
  experienceYears: number,
  requiredExperienceYears: number | null
): number {
  if (requiredExperienceYears === null || requiredExperienceYears <= 0) return 100;
  return clampScore((experienceYears / requiredExperienceYears) * 100);
}

/** Compute the bounded, explainable screening calculation for an application. */
export function calculateScreening(
  candidate: Pick<CandidateRecord, 'skills' | 'experienceYears'>,
  job: Pick<JobRequisition, 'requirements'>
): ScreeningCalculation {
  const requirements = job.requirements ?? [];
  const candidateTokens = new Set(normalizeTokens(candidate.skills));
  const matchedRequirements = requirements.filter((requirement) =>
    requirementIsMatched(requirement, candidateTokens)
  );
  const requirementsMatchPercentage =
    requirements.length === 0
      ? 0
      : (matchedRequirements.length / requirements.length) * 100;
  const requiredExperienceYears = inferRequiredExperienceYears(requirements);
  const experienceMatchPercentage = experienceFitPercentage(
    candidate.experienceYears,
    requiredExperienceYears
  );
  const score = roundedScore(
    requirementsMatchPercentage * SCREENING_REQUIREMENTS_WEIGHT +
      experienceMatchPercentage * SCREENING_EXPERIENCE_WEIGHT
  );

  const seniorityDescription =
    requiredExperienceYears === null
      ? 'no explicit experience threshold was stated'
      : `${requiredExperienceYears}+ years implied`;
  const rationale =
    `Matched ${matchedRequirements.length} of ${requirements.length} requirements ` +
    `(${roundedScore(requirementsMatchPercentage)}%); candidate has ` +
    `${candidate.experienceYears} years of experience (${seniorityDescription}), ` +
    `for a weighted score of ${score}.`;

  return {
    score,
    rationale,
    matchedRequirements: [...matchedRequirements],
    totalRequirements: requirements.length,
    requirementsMatchPercentage: roundedScore(requirementsMatchPercentage),
    requiredExperienceYears,
    experienceMatchPercentage: roundedScore(experienceMatchPercentage)
  };
}

/** Numeric screening-score convenience API used by operation handlers. */
export function calculateScreeningScore(
  candidate: Pick<CandidateRecord, 'skills' | 'experienceYears'>,
  job: Pick<JobRequisition, 'requirements'>
): number {
  return calculateScreening(candidate, job).score;
}

export const screenCandidate = calculateScreening;
