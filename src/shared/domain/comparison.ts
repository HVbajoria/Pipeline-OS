/**
 * Pure, explainable candidate-to-requisition comparison.
 *
 * The comparator intentionally has no repository, clock, random, network, or
 * model dependency. It composes the shared token normalization/Jaccard rules
 * so every caller receives the same bounded evidence and ranking.
 */

import type {
  CandidateRecord,
  JobRequisition
} from '../models';
import type {
  CandidateComparison,
  CandidateComparisonScoreBreakdown
} from '../operations';
import {
  jaccardSimilarity,
  normalizeTokens
} from './scoring';

/** Explicit weights for the advisory comparison score. */
export const COMPARISON_REQUIREMENTS_WEIGHT = 0.5;
export const COMPARISON_SKILLS_WEIGHT = 0.3;
export const COMPARISON_EXPERIENCE_WEIGHT = 0.2;

export const COMPARISON_WEIGHTS = Object.freeze({
  requirements: COMPARISON_REQUIREMENTS_WEIGHT,
  skills: COMPARISON_SKILLS_WEIGHT,
  experience: COMPARISON_EXPERIENCE_WEIGHT
});

export const COMPARISON_SCORE_PRECISION = 2;
export const COMPARISON_MAX_EVIDENCE_ITEMS = 50;
export const COMPARISON_MAX_LIMITATION_LENGTH = 300;
export const COMPARISON_MAX_RATIONALE_LENGTH = 1000;

export type ComparisonCandidate = Pick<
  CandidateRecord,
  'id' | 'name' | 'skills' | 'experienceYears'
>;

export type ComparisonJob = Pick<JobRequisition, 'requirements'>;

export type CandidateComparisonDetails = Omit<CandidateComparison, 'rank'>;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Round only at the shared output boundary so weighted evidence remains stable. */
export function roundComparisonScore(value: number): number {
  const scale = 10 ** COMPARISON_SCORE_PRECISION;
  return Math.round(clampScore(value) * scale) / scale;
}

function boundedText(value: string, maximum: number): string {
  const text = value.trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1))}…`;
}

function boundedItems(values: readonly string[], maximum = COMPARISON_MAX_EVIDENCE_ITEMS): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .slice(0, maximum)
    .map((value) => boundedText(value, 160));
}

function requirementTokens(requirement: string): string[] {
  return normalizeTokens(requirement);
}

/**
 * Infer only explicit numeric experience evidence from a requisition. Seniority
 * words alone are deliberately not treated as a numeric threshold; callers
 * receive a neutral experience score and an explicit limitation instead.
 */
export function inferExplicitExperienceYears(
  requirements: readonly string[]
): number | null {
  let inferred: number | null = null;
  for (const requirement of requirements) {
    const matches =
      requirement.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)/gi) ?? [];
    for (const match of matches) {
      const years = Number.parseFloat(match);
      if (Number.isFinite(years)) inferred = Math.max(inferred ?? 0, years);
    }
  }
  return inferred;
}

function experienceEvidence(
  experienceYears: number,
  requiredYears: number | null
): { score: number; evidence: string; limitation?: string } {
  const candidateYears = Number.isFinite(experienceYears)
    ? Math.max(0, experienceYears)
    : 0;

  if (requiredYears === null) {
    return {
      score: 50,
      evidence:
        `Candidate reports ${candidateYears} years; no explicit numeric ` +
        'experience threshold was stated, so this component is neutral (50).',
      limitation:
        'No numeric experience requirement was stated; experience fit is neutral.'
    };
  }

  const score =
    requiredYears <= 0
      ? 100
      : roundComparisonScore((candidateYears / requiredYears) * 100);
  return {
    score,
    evidence:
      `Candidate reports ${candidateYears} years; the job states ${requiredYears}+ ` +
      `years (${score}% fit).`
  };
}

function scoreBreakdownFor(
  candidate: ComparisonCandidate,
  job: ComparisonJob
): {
  scoreBreakdown: CandidateComparisonScoreBreakdown;
  limitations: string[];
  rationale: string;
} {
  const requirements = job.requirements ?? [];
  const candidateSkillTokens = normalizeTokens(candidate.skills);
  const candidateSkillSet = new Set(candidateSkillTokens);
  const requiredSkillTokens = normalizeTokens(requirements);

  // Keep the original requirement labels for human-readable evidence while
  // using the same normalized any-token matching rule as calculateScreening.
  const matchedRequirements = requirements.filter((requirement) => {
    const tokens = requirementTokens(requirement);
    return tokens.length > 0 && tokens.some((token) => candidateSkillSet.has(token));
  });
  const missingRequirements = requirements.filter(
    (requirement) => !matchedRequirements.includes(requirement)
  );
  const matchedSkills = candidateSkillTokens.filter((token) =>
    requiredSkillTokens.includes(token)
  );

  const requirementScore =
    requirements.length === 0
      ? 0
      : roundComparisonScore((matchedRequirements.length / requirements.length) * 100);
  const skillScore = roundComparisonScore(
    jaccardSimilarity(candidateSkillTokens, requiredSkillTokens) * 100
  );
  const requiredExperienceYears = inferExplicitExperienceYears(requirements);
  const experience = experienceEvidence(
    candidate.experienceYears,
    requiredExperienceYears
  );

  const scoreBreakdown: CandidateComparisonScoreBreakdown = {
    requirementMatch: {
      matched: boundedItems(matchedRequirements),
      missing: boundedItems(missingRequirements),
      score: requirementScore
    },
    skillOverlap: {
      matched: boundedItems(matchedSkills),
      score: skillScore
    },
    experienceFit: {
      evidence: boundedText(experience.evidence, 500),
      score: experience.score
    }
  };

  const limitations = [
    'Advisory comparison only; it does not make a hiring decision.'
  ];
  if (requirements.length === 0) {
    limitations.push(
      'The job has no stated requirements; requirement and skill scores are zero.'
    );
  }
  if (experience.limitation !== undefined) limitations.push(experience.limitation);

  const matchedRequirementText =
    scoreBreakdown.requirementMatch.matched.join(', ') || 'none';
  const missingRequirementText =
    scoreBreakdown.requirementMatch.missing.join(', ') || 'none';
  const matchedSkillText = scoreBreakdown.skillOverlap.matched.join(', ') || 'none';
  const rationale = boundedText(
    `Matched requirements: ${matchedRequirementText}; missing requirements: ` +
      `${missingRequirementText}; matched normalized skills: ${matchedSkillText}; ` +
      `experience: ${scoreBreakdown.experienceFit.evidence}`,
    COMPARISON_MAX_RATIONALE_LENGTH
  );

  return {
    scoreBreakdown,
    limitations: limitations
      .slice(0, 20)
      .map((limitation) => boundedText(limitation, COMPARISON_MAX_LIMITATION_LENGTH)),
    rationale
  };
}

/** Calculate one candidate's bounded, evidence-backed comparison details. */
export function calculateCandidateComparison(
  candidate: ComparisonCandidate,
  job: ComparisonJob
): CandidateComparisonDetails {
  const evidence = scoreBreakdownFor(candidate, job);
  const { requirementMatch, skillOverlap, experienceFit } = evidence.scoreBreakdown;
  const totalScore = roundComparisonScore(
    requirementMatch.score * COMPARISON_REQUIREMENTS_WEIGHT +
      skillOverlap.score * COMPARISON_SKILLS_WEIGHT +
      experienceFit.score * COMPARISON_EXPERIENCE_WEIGHT
  );

  return {
    candidateId: candidate.id,
    name: boundedText(candidate.name, 500),
    totalScore,
    scoreBreakdown: evidence.scoreBreakdown,
    rationale: evidence.rationale,
    limitations: evidence.limitations
  };
}

/**
 * Compare candidates in either `(job, candidates)` or `(candidates, job)` form.
 * The overload keeps the pure helper convenient for existing domain tests.
 */
export function compareCandidates(
  job: ComparisonJob,
  candidates: readonly ComparisonCandidate[]
): CandidateComparison[];
export function compareCandidates(
  candidates: readonly ComparisonCandidate[],
  job: ComparisonJob
): CandidateComparison[];
export function compareCandidates(
  first: ComparisonJob | readonly ComparisonCandidate[],
  second: ComparisonJob | readonly ComparisonCandidate[]
): CandidateComparison[] {
  const candidates = Array.isArray(first)
    ? (first as readonly ComparisonCandidate[])
    : (second as readonly ComparisonCandidate[]);
  const job = (Array.isArray(first) ? second : first) as ComparisonJob;

  return candidates
    .map((candidate) => calculateCandidateComparison(candidate, job))
    .sort(
      (left, right) =>
        right.totalScore - left.totalScore ||
        left.candidateId.localeCompare(right.candidateId)
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export const rankCandidateComparisons = compareCandidates;
export const calculateComparisons = compareCandidates;
