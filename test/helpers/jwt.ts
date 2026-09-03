/**
 * Real RS256 JWT signing + verification for tests, using only Node's built-in
 * `crypto` (no `jose`, no new dependency). This exercises the actual
 * cryptographic path `OidcTokenVerifier` relies on: a token is signed with a
 * private key and verified against the corresponding public key, so signature,
 * issuer/audience, and expiry checks are genuine rather than stubbed.
 */

import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject
} from 'node:crypto';
import type { VerifyJwt, VerifiedJwtPayload } from '../../src/server/auth/tokenVerifier';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

export interface TestKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

/** Generate a fresh RSA keypair for signing/verifying test tokens. */
export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  return { publicKey, privateKey };
}

export interface SignJwtOptions {
  privateKey: KeyObject | string;
  payload: Record<string, unknown>;
  /** Seconds until expiry, added as `exp` unless the payload already has one. */
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
}

/** Sign an RS256 JWT with the given private key. */
export function signJwt(options: SignJwtOptions): string {
  const key =
    typeof options.privateKey === 'string'
      ? createPrivateKey(options.privateKey)
      : options.privateKey;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    iat: nowSeconds,
    ...(options.issuer === undefined ? {} : { iss: options.issuer }),
    ...(options.audience === undefined ? {} : { aud: options.audience }),
    ...(options.payload.exp === undefined && options.expiresInSeconds !== undefined
      ? { exp: nowSeconds + options.expiresInSeconds }
      : {}),
    ...options.payload
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload)
  )}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(key)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

export interface VerifyJwtFactoryOptions {
  publicKey: KeyObject | string;
  issuer?: string;
  audience?: string;
}

/**
 * Build a `VerifyJwt` for `OidcTokenVerifier` that performs real RS256
 * signature verification against the public key (this is the crypto a JWKS
 * lookup would resolve to), plus expiry and optional issuer/audience checks.
 * Any failure throws, which the verifier maps to an InvalidTokenError.
 */
export function createVerifyJwt(options: VerifyJwtFactoryOptions): VerifyJwt {
  const key =
    typeof options.publicKey === 'string'
      ? createPublicKey(options.publicKey)
      : options.publicKey;

  return async (token: string): Promise<VerifiedJwtPayload> => {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed jwt');
    const [headerSeg, payloadSeg, signatureSeg] = parts;

    const header = JSON.parse(decodeSegment(headerSeg!).toString('utf8')) as {
      alg?: string;
    };
    if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

    const signingInput = `${headerSeg}.${payloadSeg}`;
    const valid = createVerify('RSA-SHA256')
      .update(signingInput)
      .verify(key, Buffer.from(signatureSeg!, 'base64url'));
    if (!valid) throw new Error('invalid signature');

    const payload = JSON.parse(
      decodeSegment(payloadSeg!).toString('utf8')
    ) as VerifiedJwtPayload;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp <= nowSeconds) {
      throw new Error('token expired');
    }
    if (options.issuer !== undefined && payload.iss !== options.issuer) {
      throw new Error('issuer mismatch');
    }
    if (options.audience !== undefined && payload.aud !== options.audience) {
      throw new Error('audience mismatch');
    }
    return payload;
  };
}
