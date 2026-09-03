import { describe, expect, it } from 'vitest';

import {
  OidcTokenVerifier,
  InvalidTokenError
} from '../src/server/auth/tokenVerifier';
import { claimsFromAuthInfo } from '../src/server/auth/tokenVerifier';
import { principalInputFromClaims } from '../src/server/auth/identityClaims';
import {
  createVerifyJwt,
  generateTestKeyPair,
  signJwt
} from './helpers/jwt';

const ISSUER = 'https://idp.test/';
const AUDIENCE = 'https://pipelineos.example.com/mcp';

function verifier() {
  const keys = generateTestKeyPair();
  const verifyJwt = createVerifyJwt({
    publicKey: keys.publicKey,
    issuer: ISSUER,
    audience: AUDIENCE
  });
  return {
    keys,
    tokenVerifier: new OidcTokenVerifier({
      verifyJwt,
      mapping: { tenantClaim: 'tenant', rolesClaim: 'roles' }
    })
  };
}

describe('OIDC/JWKS token verification round-trip (real RS256)', () => {
  it('verifies a well-formed token and maps standard + custom claims', async () => {
    const { keys, tokenVerifier } = verifier();
    const token = signJwt({
      privateKey: keys.privateKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresInSeconds: 3600,
      payload: {
        sub: 'sarah-recruiter',
        tenant: 'tenant-acme',
        roles: ['recruiter'],
        email: 'sarah@acme.test',
        resource_ids: { job: ['job-1'], candidate: ['cand-1', 'cand-2'] }
      }
    });

    const authInfo = await tokenVerifier.verifyAccessToken(token);
    expect(authInfo.clientId).toBe('sarah-recruiter');
    expect(authInfo.scopes).toContain('recruiter');

    const claims = claimsFromAuthInfo(authInfo);
    expect(claims).toBeDefined();
    expect(claims!.subject).toBe('sarah-recruiter');
    expect(claims!.tenantId).toBe('tenant-acme');
    expect(claims!.roles).toEqual(['recruiter']);
    expect(claims!.resourceIds?.job).toEqual(['job-1']);

    // The verified claims map into a trusted principal with tenant-stamped scopes.
    const principal = principalInputFromClaims(claims!);
    expect(principal.tenantId).toBe('tenant-acme');
    expect(principal.authenticated).toBe(true);
    expect(principal.source).toBe('trusted_host');
    expect(
      principal.resourceScopes?.every((scope) => scope.tenantId === 'tenant-acme')
    ).toBe(true);
  });

  it('rejects an expired token', async () => {
    const { keys, tokenVerifier } = verifier();
    const token = signJwt({
      privateKey: keys.privateKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      payload: {
        sub: 'sarah-recruiter',
        tenant: 'tenant-acme',
        roles: ['recruiter'],
        exp: Math.floor(Date.now() / 1000) - 60
      }
    });
    await expect(tokenVerifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it('rejects a token signed by a different (untrusted) key', async () => {
    const { tokenVerifier } = verifier();
    const attacker = generateTestKeyPair();
    const forged = signJwt({
      privateKey: attacker.privateKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresInSeconds: 3600,
      payload: { sub: 'attacker', tenant: 'tenant-acme', roles: ['admin'] }
    });
    await expect(tokenVerifier.verifyAccessToken(forged)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it('rejects a token with a mismatched audience', async () => {
    const { keys, tokenVerifier } = verifier();
    const token = signJwt({
      privateKey: keys.privateKey,
      issuer: ISSUER,
      audience: 'https://evil.example.com',
      expiresInSeconds: 3600,
      payload: { sub: 'sarah-recruiter', tenant: 'tenant-acme', roles: ['recruiter'] }
    });
    await expect(tokenVerifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it('rejects a valid signature that is missing the required tenant claim', async () => {
    const { keys, tokenVerifier } = verifier();
    const token = signJwt({
      privateKey: keys.privateKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresInSeconds: 3600,
      payload: { sub: 'sarah-recruiter', roles: ['recruiter'] }
    });
    await expect(tokenVerifier.verifyAccessToken(token)).rejects.toThrow(/tenant/i);
  });

  it('rejects a valid signature that is missing the subject', async () => {
    const { keys, tokenVerifier } = verifier();
    const token = signJwt({
      privateKey: keys.privateKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresInSeconds: 3600,
      payload: { tenant: 'tenant-acme', roles: ['recruiter'] }
    });
    await expect(tokenVerifier.verifyAccessToken(token)).rejects.toThrow(/subject/i);
  });
});
