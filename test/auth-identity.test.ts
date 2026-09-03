import { describe, expect, it } from 'vitest';

import {
  principalInputFromClaims,
  type VerifiedIdentityClaims
} from '../src/server/auth/identityClaims';
import {
  StaticClaimsTokenVerifier,
  OidcTokenVerifier,
  InvalidTokenError,
  claimsFromAuthInfo,
  AUTH_INFO_CLAIMS_KEY
} from '../src/server/auth/tokenVerifier';
import {
  createAuthorizationPolicy,
  createTrustedPrincipal
} from '../src/server/authorization';

const RECRUITER_CLAIMS: VerifiedIdentityClaims = {
  subject: 'recruiter-42',
  tenantId: 'tenant-acme',
  roles: ['recruiter'],
  email: 'r@acme.test',
  resourceIds: { job: ['job-1'], candidate: ['cand-1', 'cand-2'] }
};

const CANDIDATE_CLAIMS: VerifiedIdentityClaims = {
  subject: 'cand-1',
  tenantId: 'tenant-acme',
  roles: ['candidate'],
  resourceIds: { candidate: ['cand-1'] }
};

describe('identity claims mapping', () => {
  it('stamps tenantId on the principal and every resource scope', () => {
    const input = principalInputFromClaims(RECRUITER_CLAIMS);
    expect(input.tenantId).toBe('tenant-acme');
    expect(input.actor).toEqual({ actorType: 'human_ui', actorId: 'recruiter-42' });
    expect(input.resourceScopes?.length).toBeGreaterThan(0);
    for (const scope of input.resourceScopes ?? []) {
      expect(scope.tenantId).toBe('tenant-acme');
    }
    expect(input.source).toBe('trusted_host');
    expect(input.authenticated).toBe(true);
  });

  it('lets roles drive capabilities and grants human approval capabilities to recruiters', () => {
    const input = principalInputFromClaims(RECRUITER_CLAIMS);
    // Human capabilities come from role grants, not an explicit list.
    expect(input.capabilities ?? []).toEqual([]);
    expect(input.approvalCapabilities).toContain('workflow.plan.commit');

    const principal = createTrustedPrincipal(input);
    const policy = createAuthorizationPolicy({ environment: 'production' });
    const decision = policy.decide({
      principal,
      operation: 'create_job_requisition',
      resourceScope: { resourceType: 'job', tenantId: 'tenant-acme' }
    });
    expect(decision.authenticated).toBe(true);
    expect(decision.operationCapability.allowed).toBe(true);
  });

  it('binds candidate self scopes to the subject', () => {
    const input = principalInputFromClaims(CANDIDATE_CLAIMS);
    const selfScope = (input.resourceScopes ?? []).find(
      (scope) => scope.resourceType === 'candidate'
    );
    expect(selfScope?.mode).toBe('self');
    expect(selfScope?.subjectId).toBe('cand-1');
  });

  it('passes explicit capabilities through for a delegated agent and none for its role', () => {
    const agent = principalInputFromClaims({
      subject: 'agent-7',
      tenantId: 'tenant-acme',
      roles: ['agent'],
      agentCapabilities: ['pipeline.operation.search_candidates']
    });
    expect(agent.actor.actorType).toBe('agent');
    expect(agent.capabilities).toEqual(['pipeline.operation.search_candidates']);
    expect(agent.approvalCapabilities).toEqual([]);
  });
});

describe('cross-tenant enforcement', () => {
  it('denies a recruiter access to another tenant resource', () => {
    const acme = createTrustedPrincipal(principalInputFromClaims(RECRUITER_CLAIMS));
    const policy = createAuthorizationPolicy({ environment: 'production' });

    const sameTenant = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-1'],
        tenantId: 'tenant-acme'
      }
    });
    expect(sameTenant.allowed).toBe(true);

    const otherTenant = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-1'],
        tenantId: 'tenant-globex'
      }
    });
    expect(otherTenant.allowed).toBe(false);
    expect(otherTenant.denialReason).toBe('resource_scope');
  });

  it('does not leak the tenant id in the structured decision', () => {
    const acme = createTrustedPrincipal(principalInputFromClaims(RECRUITER_CLAIMS));
    const policy = createAuthorizationPolicy({ environment: 'production' });
    const decision = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-1'],
        tenantId: 'tenant-globex'
      }
    });
    expect(JSON.stringify(decision)).not.toContain('tenant-globex');
  });
});

describe('token verifiers', () => {
  it('static verifier returns AuthInfo carrying the verified claims', async () => {
    const verifier = new StaticClaimsTokenVerifier({
      'token-abc': { claims: RECRUITER_CLAIMS }
    });
    const authInfo = await verifier.verifyAccessToken('token-abc');
    expect(authInfo.clientId).toBe('recruiter-42');
    expect(authInfo.scopes).toContain('recruiter');
    expect(authInfo.extra?.[AUTH_INFO_CLAIMS_KEY]).toEqual(RECRUITER_CLAIMS);
    expect(claimsFromAuthInfo(authInfo)).toEqual(RECRUITER_CLAIMS);
  });

  it('static verifier rejects unknown and expired tokens', async () => {
    const verifier = new StaticClaimsTokenVerifier({
      expired: { claims: RECRUITER_CLAIMS, expiresAt: 1 }
    });
    await expect(verifier.verifyAccessToken('nope')).rejects.toBeInstanceOf(
      InvalidTokenError
    );
    await expect(verifier.verifyAccessToken('expired')).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it('oidc verifier maps standard and custom claims via the injected verifyJwt', async () => {
    const verifier = new OidcTokenVerifier({
      verifyJwt: async () => ({
        sub: 'user-9',
        tenant: 'tenant-acme',
        roles: ['recruiter', 'unknown-role'],
        resource_ids: { job: ['job-1'] },
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    });
    const authInfo = await verifier.verifyAccessToken('jwt');
    const claims = claimsFromAuthInfo(authInfo);
    expect(claims?.subject).toBe('user-9');
    expect(claims?.tenantId).toBe('tenant-acme');
    // Unknown roles are filtered out.
    expect(claims?.roles).toEqual(['recruiter']);
    expect(claims?.resourceIds?.job).toEqual(['job-1']);
  });

  it('oidc verifier rejects tokens without subject or tenant', async () => {
    const noTenant = new OidcTokenVerifier({
      verifyJwt: async () => ({ sub: 'user-9', roles: ['recruiter'] })
    });
    await expect(noTenant.verifyAccessToken('jwt')).rejects.toBeInstanceOf(
      InvalidTokenError
    );

    const noSubject = new OidcTokenVerifier({
      verifyJwt: async () => ({ tenant: 'tenant-acme' })
    });
    await expect(noSubject.verifyAccessToken('jwt')).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it('oidc verifier surfaces a verification failure as an invalid token', async () => {
    const verifier = new OidcTokenVerifier({
      verifyJwt: async () => {
        throw new Error('bad signature');
      }
    });
    await expect(verifier.verifyAccessToken('jwt')).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });
});
