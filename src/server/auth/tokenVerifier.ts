/**
 * Access-token verification for the MCP OAuth path.
 *
 * The MCP SDK's bearer middleware expects an `OAuthTokenVerifier` whose
 * `verifyAccessToken(token)` returns an `AuthInfo`. We implement that contract
 * and carry the resolved, verified identity claims in `AuthInfo.extra.claims`,
 * so the request boundary can map them into a TrustedPrincipal with the shared
 * `principalInputFromClaims` mapper.
 *
 * Two verifiers are provided:
 *   - `StaticClaimsTokenVerifier`: a deterministic map of opaque token ->
 *     claims. Used for local development, the demo, and tests. No network, no
 *     crypto, fully reproducible.
 *   - `OidcTokenVerifier`: validates a real OIDC/OAuth JWT via an injected
 *     `verifyJwt` function (JWKS/issuer/audience checks live in the host's
 *     chosen JWT library), then maps standard + custom claims into our
 *     VerifiedIdentityClaims. Injecting `verifyJwt` keeps this module free of a
 *     heavy JWT dependency and keeps it unit-testable.
 */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
// The SDK's bearer middleware maps ITS InvalidTokenError to a 401 challenge;
// any other thrown type becomes a 500. We therefore throw the SDK error.
import { InvalidTokenError as SdkInvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

import type { AuthorizationRole, ResourceScope } from '../authorization';
import { AUTHORIZATION_ROLES } from '../authorization';
import type { ActorType } from '../../shared/models';
import type { VerifiedIdentityClaims } from './identityClaims';

/** Key under which resolved claims are attached to the SDK AuthInfo. */
export const AUTH_INFO_CLAIMS_KEY = 'claims';

/** Extract the verified claims we attached during token verification. */
export function claimsFromAuthInfo(
  auth: AuthInfo | undefined
): VerifiedIdentityClaims | undefined {
  const claims = auth?.extra?.[AUTH_INFO_CLAIMS_KEY];
  return isVerifiedClaims(claims) ? claims : undefined;
}

function isVerifiedClaims(value: unknown): value is VerifiedIdentityClaims {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as VerifiedIdentityClaims).subject === 'string' &&
    typeof (value as VerifiedIdentityClaims).tenantId === 'string' &&
    Array.isArray((value as VerifiedIdentityClaims).roles)
  );
}

function authInfoFromClaims(token: string, claims: VerifiedIdentityClaims, expiresAt?: number): AuthInfo {
  return {
    token,
    clientId: claims.subject,
    // MCP scopes are coarse; the authorization policy does the real work from
    // roles/scopes. We advertise the granted app roles as token scopes.
    scopes: [...claims.roles],
    // The bearer middleware requires a numeric expiry; fall back to a default
    // TTL for grants (for example the static verifier) that omit one.
    expiresAt: expiresAt ?? defaultExpiry(),
    extra: { [AUTH_INFO_CLAIMS_KEY]: claims }
  };
}

/**
 * Thrown for an invalid/expired/unknown token. This is the SDK's own
 * InvalidTokenError so the bearer middleware returns a 401 with the correct
 * `WWW-Authenticate` challenge instead of a generic 500.
 */
export const InvalidTokenError = SdkInvalidTokenError;

/** Default token lifetime (seconds) when a grant does not specify one. */
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;

function defaultExpiry(): number {
  return Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// Static verifier (development / demo / tests)
// ---------------------------------------------------------------------------

export interface StaticTokenGrant {
  claims: VerifiedIdentityClaims;
  expiresAt?: number;
}

/**
 * A deterministic verifier backed by an in-memory token->claims map. Never use
 * this in production: it performs no cryptographic verification.
 */
export class StaticClaimsTokenVerifier implements OAuthTokenVerifier {
  private readonly grants: Map<string, StaticTokenGrant>;

  constructor(grants: Record<string, StaticTokenGrant> | Map<string, StaticTokenGrant> = {}) {
    this.grants = grants instanceof Map ? new Map(grants) : new Map(Object.entries(grants));
  }

  /** Register or replace a token grant (useful for tests and local demo). */
  set(token: string, grant: StaticTokenGrant): void {
    this.grants.set(token, grant);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.grants.get(token);
    if (grant === undefined) throw new InvalidTokenError('unknown token');
    if (grant.expiresAt !== undefined && grant.expiresAt * 1000 <= Date.now()) {
      throw new InvalidTokenError('token expired');
    }
    return authInfoFromClaims(token, grant.claims, grant.expiresAt);
  }
}

// ---------------------------------------------------------------------------
// OIDC / JWT verifier (production)
// ---------------------------------------------------------------------------

/** Decoded, signature-verified JWT payload. Shape follows OIDC conventions. */
export interface VerifiedJwtPayload {
  sub?: unknown;
  exp?: unknown;
  [claim: string]: unknown;
}

/**
 * Host-supplied JWT verification. It MUST validate signature, issuer,
 * audience, and expiry (for example with `jose.jwtVerify` against a remote
 * JWKS). Returning a payload means the token is valid.
 */
export type VerifyJwt = (token: string) => Promise<VerifiedJwtPayload>;

export interface OidcClaimMapping {
  /** Claim to read the tenant/org id from. Default `tenant`, then `org`. */
  tenantClaim?: string;
  /** Claim to read roles from. Default `roles`. */
  rolesClaim?: string;
  /** Claim to read the actor type from (`human_ui`/`agent`). Default `actor_type`. */
  actorTypeClaim?: string;
  /** Claim to read the email from. Default `email`. */
  emailClaim?: string;
  /** Claim to read granted agent capabilities from. Default `capabilities`. */
  agentCapabilitiesClaim?: string;
  /** Claim to read consent scopes from. Default `consent_scopes`. */
  consentScopesClaim?: string;
  /**
   * Claim carrying scoped resource ids as an object keyed by resource kind.
   * Default `resource_ids`.
   */
  resourceIdsClaim?: string;
}

export interface OidcTokenVerifierOptions {
  verifyJwt: VerifyJwt;
  mapping?: OidcClaimMapping;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string' && value.length > 0) {
    // Support space- or comma-delimited scalar claims.
    return value.split(/[\s,]+/u).filter((entry) => entry.length > 0);
  }
  return [];
}

function asRoles(value: unknown): AuthorizationRole[] {
  const known = new Set<string>(AUTHORIZATION_ROLES as readonly string[]);
  known.add('hiring-manager');
  return asStringArray(value).filter((role): role is AuthorizationRole =>
    known.has(role)
  );
}

function asResourceIds(
  value: unknown
): Partial<Record<ResourceScope['resourceType'], readonly string[]>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, readonly string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const ids = asStringArray(entry);
    if (ids.length > 0) result[key] = ids;
  }
  return Object.keys(result).length > 0
    ? (result as Partial<Record<ResourceScope['resourceType'], readonly string[]>>)
    : undefined;
}

/**
 * Verifies a real OIDC/OAuth JWT and maps its claims into our internal
 * VerifiedIdentityClaims. A token missing a subject or tenant is rejected,
 * so a valid-but-unscoped token cannot silently become a broad principal.
 */
export class OidcTokenVerifier implements OAuthTokenVerifier {
  private readonly verifyJwt: VerifyJwt;
  private readonly mapping: Required<OidcClaimMapping>;

  constructor(options: OidcTokenVerifierOptions) {
    this.verifyJwt = options.verifyJwt;
    const mapping = options.mapping ?? {};
    this.mapping = {
      tenantClaim: mapping.tenantClaim ?? 'tenant',
      rolesClaim: mapping.rolesClaim ?? 'roles',
      actorTypeClaim: mapping.actorTypeClaim ?? 'actor_type',
      emailClaim: mapping.emailClaim ?? 'email',
      agentCapabilitiesClaim: mapping.agentCapabilitiesClaim ?? 'capabilities',
      consentScopesClaim: mapping.consentScopesClaim ?? 'consent_scopes',
      resourceIdsClaim: mapping.resourceIdsClaim ?? 'resource_ids'
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: VerifiedJwtPayload;
    try {
      payload = await this.verifyJwt(token);
    } catch (error) {
      throw new InvalidTokenError(
        error instanceof Error ? error.message : 'jwt verification failed'
      );
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new InvalidTokenError('token is missing a subject');
    }

    const tenantRaw =
      payload[this.mapping.tenantClaim] ?? payload.org ?? payload.tenant_id;
    if (typeof tenantRaw !== 'string' || tenantRaw.length === 0) {
      throw new InvalidTokenError('token is missing a tenant claim');
    }

    const actorTypeRaw = payload[this.mapping.actorTypeClaim];
    const actorType: ActorType | undefined =
      actorTypeRaw === 'agent' || actorTypeRaw === 'human_ui'
        ? actorTypeRaw
        : undefined;

    const emailRaw = payload[this.mapping.emailClaim];

    const claims: VerifiedIdentityClaims = {
      subject,
      tenantId: tenantRaw,
      roles: asRoles(payload[this.mapping.rolesClaim]),
      ...(actorType === undefined ? {} : { actorType }),
      ...(typeof emailRaw === 'string' ? { email: emailRaw } : {}),
      ...((): { resourceIds?: VerifiedIdentityClaims['resourceIds'] } => {
        const ids = asResourceIds(payload[this.mapping.resourceIdsClaim]);
        return ids === undefined ? {} : { resourceIds: ids };
      })(),
      ...((): { agentCapabilities?: readonly string[] } => {
        const caps = asStringArray(payload[this.mapping.agentCapabilitiesClaim]);
        return caps.length > 0 ? { agentCapabilities: caps } : {};
      })(),
      ...((): { consentScopes?: readonly string[] } => {
        const scopes = asStringArray(payload[this.mapping.consentScopesClaim]);
        return scopes.length > 0 ? { consentScopes: scopes } : {};
      })()
    };

    const expiresAt = typeof payload.exp === 'number' ? payload.exp : undefined;
    return authInfoFromClaims(token, claims, expiresAt);
  }
}
