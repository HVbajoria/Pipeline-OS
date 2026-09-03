import { describe, expect, it } from 'vitest';

import {
  createAuthorizationPolicy,
  createTrustedPrincipal,
  type TrustedPrincipal
} from '../src/server/authorization';
import {
  principalInputFromClaims,
  type VerifiedIdentityClaims
} from '../src/server/auth/identityClaims';

function recruiterFor(tenantId: string, candidateIds: string[]): TrustedPrincipal {
  const claims: VerifiedIdentityClaims = {
    subject: `recruiter-${tenantId}`,
    tenantId,
    roles: ['recruiter'],
    resourceIds: {
      candidate: candidateIds,
      job: [`job-${tenantId}`]
    }
  };
  return createTrustedPrincipal(principalInputFromClaims(claims));
}

describe('cross-tenant isolation', () => {
  const policy = createAuthorizationPolicy();

  it('stamps the tenant on the principal and every resource scope', () => {
    const acme = recruiterFor('tenant-acme', ['cand-acme-1']);
    expect(acme.tenantId).toBe('tenant-acme');
    expect(acme.resourceScopes.length).toBeGreaterThan(0);
    expect(acme.resourceScopes.every((scope) => scope.tenantId === 'tenant-acme')).toBe(
      true
    );
  });

  it('allows a recruiter to read a candidate in their own tenant', () => {
    const acme = recruiterFor('tenant-acme', ['cand-acme-1']);
    const decision = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-acme-1'],
        tenantId: 'tenant-acme'
      }
    });
    expect(decision.allowed).toBe(true);
    expect(decision.resourceScope.allowed).toBe(true);
  });

  it('denies reading a candidate that belongs to a different tenant', () => {
    const acme = recruiterFor('tenant-acme', ['cand-acme-1']);
    const decision = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-globex-1'],
        tenantId: 'tenant-globex'
      }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.resourceScope.allowed).toBe(false);
    expect(decision.denialReason).toBe('resource_scope');
  });

  it('denies a write (submit_application) against another tenant', () => {
    const acme = recruiterFor('tenant-acme', ['cand-acme-1']);
    const decision = policy.decide({
      principal: acme,
      operation: 'submit_application',
      mode: 'commit',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-globex-1'],
        tenantId: 'tenant-globex'
      }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialReason).toBe('resource_scope');
  });

  it('does not leak the other tenant\'s resource id in the decision', () => {
    const acme = recruiterFor('tenant-acme', ['cand-acme-1']);
    const decision = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-globex-secret'],
        tenantId: 'tenant-globex'
      }
    });
    expect(JSON.stringify(decision)).not.toContain('cand-globex-secret');
  });

  it('isolates two tenants symmetrically (neither can reach the other)', () => {
    const acme = recruiterFor('tenant-acme', ['cand-acme-1']);
    const globex = recruiterFor('tenant-globex', ['cand-globex-1']);

    const acmeIntoGlobex = policy.decide({
      principal: acme,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-globex-1'],
        tenantId: 'tenant-globex'
      }
    });
    const globexIntoAcme = policy.decide({
      principal: globex,
      operation: 'get_candidate_profile',
      resourceScope: {
        resourceType: 'candidate',
        resourceIds: ['cand-acme-1'],
        tenantId: 'tenant-acme'
      }
    });

    expect(acmeIntoGlobex.allowed).toBe(false);
    expect(globexIntoAcme.allowed).toBe(false);
  });
});
