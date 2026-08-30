import { NotFoundError } from '../../shared/errors';
import type {
  ApplicationRecord,
  CandidateRecord
} from '../../shared/models';
import type {
  GetCandidateProfileInput,
  GetCandidateProfileOutput
} from '../../shared/operations';
import { assertRecordId } from '../../shared/validators';
import {
  deepClone
} from '../repository';
import type {
  OperationHandler,
  OperationHandlerContext
} from '../operationService';

/**
 * Return a complete candidate record together with every application submitted
 * by that candidate. The handler only reads from the isolated operation
 * snapshot and clones its result so callers cannot mutate repository records.
 */
export const getCandidateProfile: OperationHandler<'get_candidate_profile'> = (
  input: GetCandidateProfileInput,
  context: OperationHandlerContext<'get_candidate_profile'>
): GetCandidateProfileOutput => {
  const candidateId = assertRecordId(input?.candidateId, 'candidateId');
  const candidate = context.state.candidates.get(candidateId);

  if (candidate === undefined) {
    throw new NotFoundError('Candidate not found', {
      recordType: 'Candidate_Record',
      recordId: candidateId
    });
  }

  const applicationHistory = [...context.state.applications.values()]
    .filter((application) => application.candidateId === candidateId)
    .map((application) => deepClone(application));

  return {
    ...(deepClone(candidate) as CandidateRecord),
    applicationHistory
  };
};

/** Alias used by composition roots that name exports as handlers. */
export const getCandidateProfileHandler = getCandidateProfile;

export default getCandidateProfile;
