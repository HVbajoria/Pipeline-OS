/** Pure scorecard joins and panel-feedback aggregation. */

import type {
  ApplicationId,
  InterviewRecord,
  ScorecardRecord,
  ScorecardRecommendation
} from '../models';
import type {
  GetPanelFeedbackSummaryOutput,
  RecommendationTally
} from '../operations';

type Collection<T> = readonly T[] | ReadonlyMap<string, T>;

function values<T>(collection: Collection<T>): T[] {
  return Array.isArray(collection)
    ? [...collection]
    : [...(collection as ReadonlyMap<string, T>).values()];
}

/** Join scorecards through interviews belonging to the requested application. */
export function joinScorecardsForApplication(
  applicationId: ApplicationId,
  interviews: Collection<InterviewRecord>,
  scorecards: Collection<ScorecardRecord>
): ScorecardRecord[] {
  const interviewIds = new Set(
    values(interviews)
      .filter((interview) => interview.applicationId === applicationId)
      .map((interview) => interview.id)
  );
  return values(scorecards)
    .filter((scorecard) => interviewIds.has(scorecard.interviewId))
    .map((scorecard) => ({
      ...scorecard,
      competencyScores: { ...scorecard.competencyScores }
    }));
}

/** Calculate averages using only scorecards that contain each competency. */
export function averageCompetencyScores(
  scorecards: readonly ScorecardRecord[]
): Record<string, number> {
  const sums = new Map<string, { sum: number; count: number }>();
  for (const scorecard of scorecards) {
    for (const [competency, score] of Object.entries(scorecard.competencyScores)) {
      if (!Number.isFinite(score)) continue;
      const current = sums.get(competency) ?? { sum: 0, count: 0 };
      current.sum += score;
      current.count += 1;
      sums.set(competency, current);
    }
  }

  return Object.fromEntries(
    [...sums.entries()].map(([competency, value]) => [
      competency,
      value.count === 0 ? 0 : value.sum / value.count
    ])
  );
}

export const calculateAverageScores = averageCompetencyScores;

/** Count every recommendation represented by the joined scorecards. */
export function tallyRecommendations(
  scorecards: readonly ScorecardRecord[]
): RecommendationTally {
  const tally: Partial<Record<ScorecardRecommendation, number>> = {};
  for (const scorecard of scorecards) {
    const recommendation = scorecard.recommendation;
    tally[recommendation] = (tally[recommendation] ?? 0) + 1;
  }
  return tally;
}

export const aggregateRecommendations = tallyRecommendations;

/** Return the exact panel summary contract without mutating source records. */
export function aggregatePanelFeedback(
  applicationId: ApplicationId,
  interviews: Collection<InterviewRecord>,
  scorecards: Collection<ScorecardRecord>
): GetPanelFeedbackSummaryOutput {
  const joinedScorecards = joinScorecardsForApplication(
    applicationId,
    interviews,
    scorecards
  );
  return {
    averageScores: averageCompetencyScores(joinedScorecards),
    recommendationTally: tallyRecommendations(joinedScorecards),
    scorecards: joinedScorecards
  };
}

/** Support the natural `(interviews, scorecards, applicationId)` test shape. */
export function aggregateFeedback(
  applicationId: ApplicationId,
  interviews: Collection<InterviewRecord>,
  scorecards: Collection<ScorecardRecord>
): GetPanelFeedbackSummaryOutput;
export function aggregateFeedback(
  interviews: Collection<InterviewRecord>,
  scorecards: Collection<ScorecardRecord>,
  applicationId: ApplicationId
): GetPanelFeedbackSummaryOutput;
export function aggregateFeedback(
  first: ApplicationId | Collection<InterviewRecord>,
  second: Collection<InterviewRecord> | Collection<ScorecardRecord>,
  third: Collection<ScorecardRecord> | ApplicationId
): GetPanelFeedbackSummaryOutput {
  if (typeof first === 'string') {
    return aggregatePanelFeedback(
      first,
      second as Collection<InterviewRecord>,
      third as Collection<ScorecardRecord>
    );
  }
  return aggregatePanelFeedback(
    third as ApplicationId,
    first as Collection<InterviewRecord>,
    second as Collection<ScorecardRecord>
  );
}

export const getPanelFeedbackSummary = aggregatePanelFeedback;
