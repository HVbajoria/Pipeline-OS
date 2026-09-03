/**
 * Auth composition barrel.
 *
 * Bundles the token verifier (MCP bearer), the MCP OAuth resource metadata,
 * and the optional web OIDC session into one `AuthProvider` that the API
 * composition root can wire in with a single option. Everything is optional
 * and fail-closed: with no AuthProvider the server behaves exactly as before
 * (demo resolver in non-production, fail-closed in production).
 */

import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';

import type { FirebaseAuthOptions } from './firebase';
import type { McpAuthOptions } from './mcpAuth';
import type { WebAuthOptions } from './webSession';

export * from './firebase';
export * from './identityClaims';
export * from './tokenVerifier';
export * from './mcpAuth';
export * from './webSession';

export interface AuthProvider {
  /**
   * MCP OAuth: token verifier plus resource metadata used to guard `/mcp`
   * with bearer auth and advertise the protected-resource discovery document.
   */
  mcp?: {
    verifier: OAuthTokenVerifier;
    resourceUrl: string;
    authorizationServers: readonly string[];
    resourceName?: string;
    scopesSupported?: readonly string[];
  };
  /** Optional interactive web OIDC login for human users. */
  web?: WebAuthOptions;
  /** Optional Firebase Authentication session bridge for browser users. */
  firebase?: FirebaseAuthOptions;
}

/** Narrow the MCP config into the McpAuthOptions the middleware expects. */
export function mcpAuthOptionsFromProvider(
  provider: AuthProvider
): McpAuthOptions | undefined {
  if (provider.mcp === undefined) return undefined;
  return {
    verifier: provider.mcp.verifier,
    resourceUrl: provider.mcp.resourceUrl,
    authorizationServers: provider.mcp.authorizationServers,
    ...(provider.mcp.resourceName === undefined
      ? {}
      : { resourceName: provider.mcp.resourceName }),
    ...(provider.mcp.scopesSupported === undefined
      ? {}
      : { scopesSupported: provider.mcp.scopesSupported })
  };
}
