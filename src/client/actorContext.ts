import type { ActorContext } from '../shared/models';

/** Human-facing roles that carry a stable demo actor identity. */
export type HumanRole = 'recruiter' | 'candidate' | 'hiring-manager';
export type AppRole = HumanRole | 'documentation';

/** The demo identities are metadata only; they are never operation input. */
export const ROLE_ACTOR_IDS = {
  recruiter: 'sarah-recruiter',
  candidate: 'alice-candidate',
  'hiring-manager': 'morgan-hiring-manager'
} as const satisfies Record<HumanRole, string>;

export const DEFAULT_AGENT_CONTEXT: ActorContext = {
  actorType: 'agent',
  actorId: 'agent-demo'
};

export const DEFAULT_HUMAN_CONTEXT: ActorContext = {
  actorType: 'human_ui',
  actorId: ROLE_ACTOR_IDS.recruiter
};

/** Resolve the actor metadata used by a human role's UI handlers. */
export function actorContextForRole(role: HumanRole | AppRole): ActorContext {
  const resolvedRole = role === 'documentation' ? 'recruiter' : role;
  return {
    actorType: 'human_ui',
    actorId: ROLE_ACTOR_IDS[resolvedRole]
  };
}

export function actorContextForAgent(actorId = DEFAULT_AGENT_CONTEXT.actorId): ActorContext {
  return {
    actorType: 'agent',
    actorId: actorId.trim() || DEFAULT_AGENT_CONTEXT.actorId
  };
}

/**
 * Small mutable provider used by non-React consumers that need the current
 * human actor without importing Zustand. React views normally pass the actor
 * returned by `actorContextForRole` at their operation boundary.
 */
export class ActorContextProvider {
  private role: HumanRole = 'recruiter';

  constructor(initialRole: HumanRole = 'recruiter') {
    this.role = initialRole;
  }

  setRole(role: HumanRole): void {
    this.role = role;
  }

  getRole(): HumanRole {
    return this.role;
  }

  getActorContext(): ActorContext {
    return actorContextForRole(this.role);
  }
}

export function createActorContextProvider(
  initialRole: HumanRole = 'recruiter'
): ActorContextProvider {
  return new ActorContextProvider(initialRole);
}
