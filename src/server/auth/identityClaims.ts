/**
 * Identity-claims -> TrustedPrincipal mapping.
 *
 * This is the ONE place that turns a set of already-verified identity claims
 * (from an OIDC ID token, an OAuth access token, or a web session) into the
 * server-only `TrustedPrincipalInput` that the authorization policy consumes.
 * The web login path and the MCP OAuth path both funnel through here so that
 * roles, capabilities, tenant, and resource scopes are derived identically
 * regardless of transport.
 *
 * Two invariants this module guarantees:
 *   1. Roles drive capabilities. We set `roles` on the principal and let the
 *      policy's ROLE_CAPABILITY_GRANTS expand them, rather than hand-copying a
 *      capability list. Agents are the exception: an agent role grants nothing
 *      by design, so a delegated agent's explicit capabilities are passed
 *      through unchanged.
 *   2. Tenant is stamped everywhere. The principal AND every resource scope
 *      carry the same `tenantId`, which is what activates the tenant gate in
 *      the authorization policy (`tenantMatches` in `scopeMatches`). Without a
 *      tenant on the scopes, tenancy is dormant; with it, cross-tenant reads
 *      and writes fail closed.
 */

import type {
  AuthorizationRole,
  ResourceScope,
  ResourceScopeMode,
  TrustedPrincipalInput
} from '../authorization';
import type { ActorType } from '../../shared/models';

/**
 * The minimal, transport-agnostic claim set we require after a token or
 * session has been verified upstream. Anything here is trusted input; callers
 * MUST verify signatures/sessions before constructing this.
 */
export interface VerifiedIdentityClaims {
  /** Stable subject identifier (OIDC `sub`), used as the audit actor id. */
  subject: string;
  /** Tenant / organization identifier. Required for multi-tenant isolation. */
  tenantId: string;
  /** Application roles resolved from the IdP (claim mapping is host-specific). */
  roles: readonly AuthorizationRole[];
  /** Whether this identity is a human user or a delegated agent. */
  actorType?: ActorType;
  /** Optional email, kept only for display/audit; never used for authz. */
  email?: string;
  /**
   * Resource ids the identity is scoped to, keyed by resource kind. For a
   * candidate this is typically their own candidate id; for a recruiter it is
   * the reqs/candidates they are assigned. Omit to grant a bounded
   * collection-level scope (assigned/delegated without ids).
   */
  resourceIds?: Partial<Record<ResourceScope['resourceType'], readonly string[]>>;
  /**
   * Explicit capabilities for a delegated agent. Ignored for human roles,
   * whose capabilities come from the role grants.
   */
  agentCapabilities?: readonly string[];
  /** Consent scopes granted by the host (e.g. public-prospect sourcing). */
  consentScopes?: readonly string[];
}

/** Roles permitted to act as a human approval principal. */
const APPROVAL_ROLES: ReadonlySet<AuthorizationRole> = new Set([
  'recruiter',
  'admin',
  'system'
]);

const HUMAN_APPROVAL_CAPABILITIES = [
  'workflow.approval.approve',
  'workflow.approval.reject',
  'workflow.plan.commit'
] as const;

/**
 * The scope shape each role receives. `mode` follows the same self/assigned/
 * delegated model the demo uses; ids come from claims when present.
 */
const ROLE_SCOPE_TEMPLATES: Readonly<
  Record<AuthorizationRole, ReadonlyArray<{ resourceType: ResourceScope['resourceType']; mode: ResourceScopeMode; self?: boolean }>>
> = {
  recruiter: [
    { resourceType: 'job', mode: 'assigned' },
    { resourceType: 'candidate', mode: 'assigned' },
    { resourceType: 'application', mode: 'assigned' },
    { resourceType: 'panel', mode: 'assigned' },
    { resourceType: 'offer', mode: 'assigned' },
    { resourceType: 'onboarding', mode: 'assigned' },
    { resourceType: 'prospect', mode: 'all' }
  ],
  candidate: [
    { resourceType: 'candidate', mode: 'self', self: true },
    { resourceType: 'application', mode: 'self', self: true },
    { resourceType: 'offer', mode: 'self', self: true },
    { resourceType: 'onboarding', mode: 'self', self: true }
  ],
  hiring_manager: [
    { resourceType: 'job', mode: 'assigned' },
    { resourceType: 'candidate', mode: 'assigned' },
    { resourceType: 'application', mode: 'assigned' },
    { resourceType: 'panel', mode: 'assigned' }
  ],
  'hiring-manager': [
    { resourceType: 'job', mode: 'assigned' },
    { resourceType: 'candidate', mode: 'assigned' },
    { resourceType: 'application', mode: 'assigned' },
    { resourceType: 'panel', mode: 'assigned' }
  ],
  interviewer: [
    { resourceType: 'candidate', mode: 'assigned' },
    { resourceType: 'interview', mode: 'assigned' },
    { resourceType: 'panel', mode: 'assigned' }
  ],
  agent: [
    { resourceType: 'job', mode: 'delegated' },
    { resourceType: 'candidate', mode: 'delegated' },
    { resourceType: 'application', mode: 'delegated' },
    { resourceType: 'offer', mode: 'delegated' },
    { resourceType: 'prospect', mode: 'delegated' }
  ],
  admin: [{ resourceType: '*', mode: 'all' }],
  system: [{ resourceType: '*', mode: 'all' }]
};

function actorTypeForRoles(
  roles: readonly AuthorizationRole[],
  explicit?: ActorType
): ActorType {
  if (explicit !== undefined) return explicit;
  return roles.includes('agent') ? 'agent' : 'human_ui';
}

function scopesForClaims(claims: VerifiedIdentityClaims): ResourceScope[] {
  const seen = new Set<string>();
  const scopes: ResourceScope[] = [];

  for (const role of claims.roles) {
    const templates = ROLE_SCOPE_TEMPLATES[role] ?? [];
    for (const template of templates) {
      const key = `${template.resourceType}:${template.mode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const ids = claims.resourceIds?.[template.resourceType];
      const scope: ResourceScope = {
        resourceType: template.resourceType,
        mode: template.mode,
        // Tenant is stamped on EVERY scope so the policy's tenantMatches gate
        // is active. A scope without a tenant would match any tenant.
        tenantId: claims.tenantId,
        ...(ids !== undefined && ids.length > 0 ? { resourceIds: [...ids] } : {}),
        // A self scope binds to the subject so ownership checks resolve.
        ...(template.self ? { subjectId: claims.subject } : {})
      };
      scopes.push(scope);
    }
  }

  return scopes;
}

/**
 * Map verified claims into the trusted principal input consumed by the policy.
 * The result is fail-safe: an empty role set yields a principal with no
 * capabilities and no scopes, which the policy denies.
 */
export function principalInputFromClaims(
  claims: VerifiedIdentityClaims
): TrustedPrincipalInput {
  const roles = [...new Set(claims.roles)];
  const actorType = actorTypeForRoles(roles, claims.actorType);
  const isHuman = actorType === 'human_ui';

  const approvalCapabilities = isHuman
    ? roles.some((role) => APPROVAL_ROLES.has(role))
      ? [...HUMAN_APPROVAL_CAPABILITIES]
      : []
    : [];

  // Human capabilities come from role grants; a delegated agent uses its
  // explicit, host-granted capability list (the agent role grants nothing).
  const capabilities = isHuman ? [] : [...(claims.agentCapabilities ?? [])];

  return {
    actor: { actorType, actorId: claims.subject },
    roles,
    tenantId: claims.tenantId,
    authenticationStatus: 'authenticated',
    authenticated: true,
    trusted: true,
    source: 'trusted_host',
    resourceScopes: scopesForClaims(claims),
    approvalCapabilities,
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(claims.consentScopes !== undefined && claims.consentScopes.length > 0
      ? { consentScopes: [...claims.consentScopes] }
      : {})
  };
}
