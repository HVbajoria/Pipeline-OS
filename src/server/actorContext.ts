/** HTTP-to-domain actor context resolution for the shared operation boundary. */

import type { Request } from 'express';
import type { ActorContext } from '../shared/models';
import { assertActorContext } from '../shared/validators';

export const DEFAULT_HUMAN_ACTOR_ID = 'sarah-recruiter';
export const DEFAULT_AGENT_ACTOR_ID = 'agent-demo';

export const DEFAULT_HUMAN_ACTOR_CONTEXT: ActorContext = {
  actorType: 'human_ui',
  actorId: DEFAULT_HUMAN_ACTOR_ID
};

export const DEFAULT_AGENT_ACTOR_CONTEXT: ActorContext = {
  actorType: 'agent',
  actorId: DEFAULT_AGENT_ACTOR_ID
};

type HeaderValue = string | string[] | undefined;
export type ActorHeaders = Record<string, HeaderValue>;

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function header(headers: ActorHeaders, name: string): string | undefined {
  return firstHeaderValue(headers[name.toLowerCase()]);
}

/** Resolve actor metadata from plain headers, useful for HTTP and unit tests. */
export function actorContextFromHeaders(headers: ActorHeaders): ActorContext {
  const requestedType = header(headers, 'x-actor-type');
  const actorType = requestedType ?? DEFAULT_HUMAN_ACTOR_CONTEXT.actorType;
  const defaultActorId =
    actorType === 'agent'
      ? DEFAULT_AGENT_ACTOR_CONTEXT.actorId
      : DEFAULT_HUMAN_ACTOR_CONTEXT.actorId;
  const actorId = header(headers, 'x-actor-id') ?? defaultActorId;

  return assertActorContext({ actorType, actorId });
}

/** Resolve the current human/agent actor at the Express request boundary. */
export function resolveActorContext(
  request: Pick<Request, 'headers'>
): ActorContext {
  return actorContextFromHeaders(request.headers as ActorHeaders);
}

export const getActorContext = resolveActorContext;
