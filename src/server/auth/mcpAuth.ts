/**
 * MCP OAuth wiring for the `/mcp` endpoint.
 *
 * A remote MCP client such as a ChatGPT connector authenticates with an OAuth
 * 2.0 bearer token. Per the MCP authorization spec this server behaves as an
 * OAuth Protected Resource:
 *   - It advertises `/.well-known/oauth-protected-resource` (RFC 9728) so the
 *     client can discover which authorization server to use.
 *   - It requires a valid bearer token on `/mcp` via the SDK's
 *     `requireBearerAuth` middleware, which returns 401 with a
 *     `WWW-Authenticate` header pointing at the resource metadata when the
 *     token is missing or invalid.
 *
 * After the middleware validates the token, `request.auth` carries the
 * verified claims. `principalFromBearerRequest` maps those claims into the
 * same TrustedPrincipal the rest of the system uses, so the MCP path shares
 * the identical authorization and tenant boundary as the web/API paths.
 */

import type { RequestHandler, Request } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';

import {
  createTrustedPrincipal,
  createUnauthenticatedPrincipal,
  type TrustedPrincipal
} from '../authorization';
import { principalInputFromClaims } from './identityClaims';
import { claimsFromAuthInfo } from './tokenVerifier';
import type { RequestIdentity } from '../api';

/** Standard RFC 9728 discovery path for the protected resource metadata. */
export const PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource';

export interface McpAuthOptions {
  /** Verifies the bearer access token and attaches claims to `request.auth`. */
  verifier: OAuthTokenVerifier;
  /**
   * The canonical URL of this MCP resource server (for example
   * `https://pipelineos.example.com/mcp`). Advertised in the resource metadata
   * and used to build the `WWW-Authenticate` challenge on 401.
   */
  resourceUrl: string;
  /**
   * One or more authorization server issuer URLs a client may use to obtain a
   * token for this resource.
   */
  authorizationServers: readonly string[];
  /** Optional human-readable resource name for the metadata document. */
  resourceName?: string;
  /** Optional scopes advertised as supported by this resource. */
  scopesSupported?: readonly string[];
}

/**
 * The Express handler for `/.well-known/oauth-protected-resource`. ChatGPT and
 * other MCP clients fetch this to learn which authorization server to send the
 * user to before calling `/mcp`.
 */
export function createProtectedResourceMetadataHandler(
  options: McpAuthOptions
): RequestHandler {
  return metadataHandler({
    resource: options.resourceUrl,
    authorization_servers: [...options.authorizationServers],
    ...(options.resourceName === undefined
      ? {}
      : { resource_name: options.resourceName }),
    ...(options.scopesSupported === undefined
      ? {}
      : { scopes_supported: [...options.scopesSupported] })
  });
}

/**
 * The bearer-auth middleware guarding `/mcp`. On a missing/invalid token it
 * returns 401 with `WWW-Authenticate` referencing the resource metadata URL,
 * which is exactly what an MCP client needs to begin the OAuth flow.
 */
export function createMcpBearerMiddleware(
  options: McpAuthOptions,
  resourceMetadataUrl: string
): RequestHandler {
  return requireBearerAuth({
    verifier: options.verifier,
    resourceMetadataUrl
  });
}

/**
 * Map the bearer-authenticated request into a TrustedPrincipal. The bearer
 * middleware has already validated the token and populated `request.auth`;
 * here we only translate the verified claims. If claims are missing (which
 * should not happen once the middleware has run) we fail closed.
 */
export function principalFromBearerRequest(request: Request): TrustedPrincipal {
  const claims = claimsFromAuthInfo(request.auth);
  if (claims === undefined) {
    return createUnauthenticatedPrincipal('missing_principal');
  }
  try {
    return createTrustedPrincipal(principalInputFromClaims(claims));
  } catch {
    return createUnauthenticatedPrincipal('invalid_principal');
  }
}

/** Identity resolver for the MCP handler when bearer auth is enabled. */
export function bearerIdentityResolver(): (
  request: Request
) => Promise<RequestIdentity> {
  return async (request: Request) => {
    const principal = principalFromBearerRequest(request);
    return { actor: principal.actor, principal };
  };
}
