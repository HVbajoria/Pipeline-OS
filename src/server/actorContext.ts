/** HTTP-to-domain actor context resolution for the shared operation boundary. */

import type { Request } from 'express';
import type { ActorContext } from '../shared/models';
import { assertActorContext } from '../shared/validators';
import type {
  AuthorizationEnvironment,
  TrustedActorResolutionInput,
  TrustedActorResolver,
  TrustedPrincipal
} from './authorization';

export const DEFAULT_HUMAN_ACTOR_ID = 'sarah-recruiter';
export const DEFAULT_AGENT_ACTOR_ID = 'agent-demo';
export const UNAUTHENTICATED_ACTOR_ID = 'unauthenticated';

export const DEFAULT_HUMAN_ACTOR_CONTEXT: ActorContext = {
  actorType: 'human_ui',
  actorId: DEFAULT_HUMAN_ACTOR_ID
};

export const DEFAULT_AGENT_ACTOR_CONTEXT: ActorContext = {
  actorType: 'agent',
  actorId: DEFAULT_AGENT_ACTOR_ID
};

/** Safe audit identity used when no trusted principal exists. */
export const UNAUTHENTICATED_ACTOR_CONTEXT: ActorContext = {
  actorType: 'human_ui',
  actorId: UNAUTHENTICATED_ACTOR_ID
};

type HeaderValue = string | string[] | undefined;
export type ActorHeaders = Record<string, HeaderValue>;

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function header(headers: ActorHeaders, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  const direct = headers[normalizedName];
  if (direct !== undefined) return firstHeaderValue(direct);

  // Node/Express normally lower-case headers, while plain-object tests and
  // embedding hosts sometimes retain their original casing.
  const matchingKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === normalizedName
  );
  return matchingKey === undefined
    ? undefined
    : firstHeaderValue(headers[matchingKey]);
}

/**
 * Legacy header parsing for local callers.  This returns presentation metadata
 * only; it is not an authentication check and must not be used as a trusted
 * production identity source.
 */
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

export interface ResolveTrustedActorOptions {
  environment?: AuthorizationEnvironment;
  /** Optional normalized headers supplied by an adapter (for example SSE query fallback). */
  headers?: ActorHeaders;
  trustedSession?: unknown;
  trustedPrincipal?: unknown;
}

/**
 * Adapter helper for a future/API boundary that has an injected resolver.  It
 * intentionally sits beside, rather than replacing, resolveActorContext so
 * old direct callers and aliases continue to receive the legacy audit shape.
 */
export function resolveTrustedActorContext(
  request: Pick<Request, 'headers'>,
  resolver: TrustedActorResolver,
  options: ResolveTrustedActorOptions = {}
): Promise<TrustedPrincipal> {
  const input: TrustedActorResolutionInput = {
    request,
    headers: options.headers ?? (request.headers as ActorHeaders),
    environment: options.environment,
    trustedSession: options.trustedSession,
    trustedPrincipal: options.trustedPrincipal
  };
  return Promise.resolve(resolver.resolve(input));
}

export const getTrustedActorContext = resolveTrustedActorContext;
