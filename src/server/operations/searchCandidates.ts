/**
 * Shared read-only implementation of the `search_candidates` operation.
 *
 * Candidate ranking lives in the pure scoring module so UI and WebMCP calls
 * receive the same score, rationale, ordering, and ten-result limit. The
 * operation service supplies an isolated snapshot for this read-only handler;
 * this module never mutates repository state.
 */

import { rankCandidates } from '../../shared/domain/scoring';
import type { OperationHandler } from '../operationService';

/** Rank every candidate in the snapshot and return the canonical search output. */
export const searchCandidates: OperationHandler<'search_candidates'> = (
  input,
  context
) => ({
  results: rankCandidates([...context.state.candidates.values()], input)
});

/** Descriptive alias for callers that register handlers by implementation name. */
export const searchCandidatesHandler = searchCandidates;

export default searchCandidates;
