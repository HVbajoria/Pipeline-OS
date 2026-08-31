/** Shared server handler for public GitHub prospect sourcing. */

import type { ActorContext } from '../../shared/models';
import { ForbiddenError, InternalError } from '../../shared/errors';
import type {
  SearchPublicCandidatesOutput,
  SearchPublicCandidatesInput
} from '../../shared/operations';
import type { OperationHandler } from '../operationService';
import {
  toGitHubPipelineError,
  type GitHubProspectServiceApi
} from '../prospects';

/** The recruiter demo identity permitted to source public prospects. */
export const DEFAULT_PUBLIC_PROSPECT_RECRUITER_ID = 'sarah-recruiter';
/** The default agent/WebMCP identity permitted to source public prospects. */
export const DEFAULT_PUBLIC_PROSPECT_AGENT_ID = 'agent-demo';

export interface SearchPublicCandidatesAuthorizationOptions {
  recruiterActorId?: string;
  authorizedAgentIds?: readonly string[];
}

function isAuthorizedActor(
  actor: ActorContext,
  options: Required<SearchPublicCandidatesAuthorizationOptions>
): boolean {
  if (
    actor.actorType === 'human_ui' &&
    actor.actorId === options.recruiterActorId
  ) {
    return true;
  }

  return (
    actor.actorType === 'agent' &&
    options.authorizedAgentIds.includes(actor.actorId)
  );
}

function authorizationOptions(
  options: SearchPublicCandidatesAuthorizationOptions = {}
): Required<SearchPublicCandidatesAuthorizationOptions> {
  return {
    recruiterActorId:
      options.recruiterActorId ?? DEFAULT_PUBLIC_PROSPECT_RECRUITER_ID,
    authorizedAgentIds: options.authorizedAgentIds ?? [DEFAULT_PUBLIC_PROSPECT_AGENT_ID]
  };
}

/**
 * Create the operation handler with its server-only GitHub service dependency.
 * The service is deliberately not read from the browser, operation input, or
 * handler context, and its result is returned through OperationService so the
 * normal output validation and activity audit still apply.
 */
export function createSearchPublicCandidatesHandler(
  githubProspects?: GitHubProspectServiceApi,
  authorization: SearchPublicCandidatesAuthorizationOptions = {}
): OperationHandler<'search_public_candidates'> {
  const access = authorizationOptions(authorization);

  return async (
    input: SearchPublicCandidatesInput,
    context
  ): Promise<SearchPublicCandidatesOutput> => {
    if (!isAuthorizedActor(context.actor, access)) {
      throw new ForbiddenError(
        'GitHub public-prospect search is available only to authorized recruiter actors'
      );
    }

    if (githubProspects === undefined) {
      throw new InternalError('GitHub public-prospect service is not configured');
    }

    try {
      // OperationService has already normalized and validated this input. The
      // server service owns network access, caching, redaction, and upstream
      // error classification; no domain collection is touched here.
      return await githubProspects.search(input);
    } catch (error) {
      throw toGitHubPipelineError(error);
    }
  };
}

/** Placeholder used only when a direct service composition has not injected a service yet. */
export const searchPublicCandidates = createSearchPublicCandidatesHandler();
export const searchPublicCandidatesHandler = searchPublicCandidates;

export default searchPublicCandidates;
