/**
 * Firebase Authentication adapter for browser users.
 *
 * The browser signs in with the Firebase Web SDK and sends the resulting ID
 * token once to `/auth/firebase/session`. The Admin SDK verifies that token,
 * maps only verified claims into PipelineOS identity claims, and creates the
 * same signed, httpOnly session cookie used by the existing web-session
 * resolver. API requests and native EventSource then use the cookie without
 * placing bearer tokens in URLs.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

import {
  AUTHORIZATION_ROLES,
  type AuthorizationRole
} from '../authorization';
import {
  getPersistenceApp,
  type FirestoreBootstrapOptions
} from '../persistence/firestore';
import {
  clearSessionCookie,
  createWebSessionResolver,
  InMemoryWebSessionStore,
  parseCookies,
  SESSION_COOKIE_NAME,
  setSessionCookie,
  signSessionId,
  verifySignedSessionId,
  type WebSession,
  type WebSessionStore
} from './webSession';
import type { VerifiedIdentityClaims } from './identityClaims';
import type { UserActivityStore } from '../persistence/firestoreUserStore';

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_ROLE: AuthorizationRole = 'candidate';
const DEFAULT_TENANT = 'pipelineos-demo';
const PIPELINEOS_ADMIN_EMAIL = 'admin@pipelineos.com';

export interface FirebaseAuthOptions
  extends Pick<FirestoreBootstrapOptions, 'projectId' | 'serviceAccount' | 'credentialsPath'> {
  /** Secret used to sign the PipelineOS httpOnly session cookie. */
  cookieSecret: string;
  /** Session lifetime in milliseconds. Defaults to eight hours. */
  sessionTtlMs?: number;
  /** Secure cookie flag; should remain true on HTTPS deployments. */
  secureCookie?: boolean;
  /** Server-controlled fallback tenant for tokens without a tenant claim. */
  defaultTenantId?: string;
  /** Server-controlled fallback role for first-time Firebase users. */
  defaultRole?: AuthorizationRole;
  /** Optional durable session store supplied by the composition root. */
  store?: WebSessionStore;
  /** Optional best-effort user profile/action projection. */
  userStore?: Pick<UserActivityStore, 'upsertIdentity' | 'getIdentity'>;
  /** Test seam for Firebase Admin token verification. */
  verifyIdToken?: (
    token: string,
    checkRevoked: boolean
  ) => Promise<DecodedIdToken>;
}

export interface FirebaseSessionInfo {
  authenticated: true;
  subject: string;
  tenantId: string;
  roles: readonly AuthorizationRole[];
  displayName?: string;
  email?: string;
}

function claimString(token: DecodedIdToken, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = token[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function claimStringArray(token: DecodedIdToken, ...names: string[]): string[] {
  for (const name of names) {
    const value = token[name];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.split(/[\s,]+/u).filter((entry) => entry.length > 0);
    }
  }
  return [];
}

function claimResourceIds(
  token: DecodedIdToken
): VerifiedIdentityClaims['resourceIds'] | undefined {
  const value = token.resource_ids ?? token.resourceIds;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, readonly string[]> = {};
  for (const [resourceType, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const strings = ids.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (strings.length > 0) result[resourceType] = strings;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Roles a brand-new user may self-select at sign-up. Privileged roles (admin,
 * system, agent) are intentionally excluded: they can only be granted through
 * verified token claims set server-side, never from a browser request body.
 */
const SELF_SELECTABLE_ROLES = new Set<AuthorizationRole>([
  'candidate',
  'recruiter',
  'hiring-manager',
  'interviewer'
]);

function requestedRole(request: Request): AuthorizationRole | undefined {
  const body = request.body as { requestedRole?: unknown } | undefined;
  const value = body?.requestedRole;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SELF_SELECTABLE_ROLES.has(trimmed as AuthorizationRole)
    ? (trimmed as AuthorizationRole)
    : undefined;
}

function firebaseRoles(
  token: DecodedIdToken,
  fallback: AuthorizationRole | undefined,
  requested: AuthorizationRole | undefined
): AuthorizationRole[] {
  const known = new Set<string>(AUTHORIZATION_ROLES as readonly string[]);
  known.add('hiring-manager');
  const claimed = claimStringArray(token, 'roles', 'role').filter((role) => known.has(role));
  // A verified token claim is authoritative and always wins over any
  // browser-supplied role. Only when the account has no role claim do we honor
  // a self-selected role from sign-up, and only from the safe allowlist.
  if (claimed.length > 0) return [...new Set(claimed)] as AuthorizationRole[];
  if (requested !== undefined) return [requested];
  return fallback === undefined ? [] : [fallback];
}

function isPipelineOSAdmin(token: DecodedIdToken): boolean {
  return (
    token.email_verified === true &&
    typeof token.email === 'string' &&
    token.email.trim().toLowerCase() === PIPELINEOS_ADMIN_EMAIL
  );
}

function claimsFromFirebaseToken(
  token: DecodedIdToken,
  options: FirebaseAuthOptions,
  requested: AuthorizationRole | undefined
): VerifiedIdentityClaims {
  const tenantId =
    claimString(token, 'tenantId', 'tenant', 'org', 'tenant_id') ??
    options.defaultTenantId;
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error('Firebase user is missing a tenant claim');
  }

  const resolvedRoles = firebaseRoles(token, options.defaultRole, requested);
  // The email is trusted only after Firebase Admin verifies the token and the
  // account's email address. Never grant admin from a browser request body or
  // an unverified email claim.
  const roles = isPipelineOSAdmin(token)
    ? [...new Set([...resolvedRoles, 'admin'])] as AuthorizationRole[]
    : resolvedRoles;
  if (roles.length === 0) {
    throw new Error('Firebase user is missing an authorized role claim');
  }

  const claims: VerifiedIdentityClaims = {
    subject: token.uid,
    tenantId,
    roles,
    // Firebase users are human principals. Never let a browser claim turn a
    // normal Firebase account into a delegated agent.
    actorType: 'human_ui',
    ...(typeof token.name === 'string' && token.name.trim().length > 0
      ? { displayName: token.name.trim() }
      : {}),
    ...(typeof token.email === 'string' ? { email: token.email } : {}),
    ...(claimResourceIds(token) === undefined ? {} : { resourceIds: claimResourceIds(token) }),
    ...(claimStringArray(token, 'consent_scopes', 'consentScopes').length === 0
      ? {}
      : { consentScopes: claimStringArray(token, 'consent_scopes', 'consentScopes') })
  };

  return claims;
}

async function claimsWithStoredIdentity(
  claims: VerifiedIdentityClaims,
  userStore: FirebaseAuthOptions['userStore']
): Promise<VerifiedIdentityClaims> {
  if (userStore === undefined) return claims;
  try {
    const stored = await userStore.getIdentity(claims.subject, claims.tenantId);
    if (stored === undefined || stored.roles.length === 0) return claims;
    return {
      ...claims,
      // The server-managed Firestore user record is authoritative after the
      // initial account bootstrap. Browser requestedRole and token roles never
      // overwrite an existing stored role.
      roles: [...stored.roles],
      ...(stored.displayName === undefined && claims.displayName === undefined
        ? {}
        : { displayName: stored.displayName ?? claims.displayName }),
      ...(stored.email === undefined && claims.email === undefined
        ? {}
        : { email: stored.email ?? claims.email })
    };
  } catch {
    // A temporary profile-read failure should not make a valid Firebase token
    // unusable; the verified token claims remain the safe fallback.
    return claims;
  }
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1];
}

function sessionInfo(session: WebSession): FirebaseSessionInfo {
  return {
    authenticated: true,
    subject: session.claims.subject,
    tenantId: session.claims.tenantId,
    roles: session.claims.roles,
    ...(session.claims.displayName === undefined
      ? {}
      : { displayName: session.claims.displayName }),
    ...(session.claims.email === undefined ? {} : { email: session.claims.email })
  };
}

function publicSessionResponse(response: Response, session: WebSession): void {
  response.json(sessionInfo(session));
}

/**
 * Mount Firebase token exchange, session, and logout routes. The returned
 * store must be passed to createWebSessionResolver so both paths share state.
 */
export function installFirebaseAuthRoutes(
  app: Express,
  options: FirebaseAuthOptions
): WebSessionStore {
  const store = options.store ?? new InMemoryWebSessionStore();
  const secureCookie = options.secureCookie ?? true;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const verifyIdToken =
    options.verifyIdToken ??
    ((token: string, checkRevoked: boolean) =>
      getAuth(
        getPersistenceApp({
          ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
          ...(options.serviceAccount === undefined ? {} : { serviceAccount: options.serviceAccount }),
          ...(options.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath })
        })
      ).verifyIdToken(token, checkRevoked));

  app.post('/auth/firebase/session', async (request, response) => {
    try {
      const token = bearerToken(request);
      if (token === undefined) {
        response.status(401).json({ error: 'missing_firebase_token' });
        return;
      }
      const decoded = await verifyIdToken(token, true);
      const tokenClaims = claimsFromFirebaseToken(decoded, options, requestedRole(request));
      const claims = await claimsWithStoredIdentity(tokenClaims, options.userStore);
      void Promise.resolve(options.userStore?.upsertIdentity({
        subject: claims.subject,
        tenantId: claims.tenantId,
        actorType: claims.actorType ?? 'human_ui',
        roles: claims.roles,
        ...(claims.displayName === undefined ? {} : { displayName: claims.displayName }),
        ...(claims.email === undefined ? {} : { email: claims.email }),
        source: 'trusted_session'
      })).catch(() => undefined);
      const now = Date.now();
      const session: WebSession = {
        sessionId: randomUUID(),
        claims,
        createdAt: now,
        expiresAt: now + sessionTtlMs
      };
      await store.set(session);
      setSessionCookie(
        response,
        signSessionId(session.sessionId, options.cookieSecret),
        sessionTtlMs,
        secureCookie
      );
      publicSessionResponse(response, session);
    } catch {
      response.status(401).json({ error: 'firebase_authentication_failed' });
    }
  });

  app.post('/auth/logout', async (request, response) => {
    const cookies = parseCookies(request);
    const signed = cookies[SESSION_COOKIE_NAME];
    if (signed !== undefined) {
      const sessionId = verifySignedSessionId(signed, options.cookieSecret);
      if (sessionId !== undefined) await store.delete(sessionId);
    }
    clearSessionCookie(response, secureCookie);
    response.json({ success: true });
  });

  app.get('/auth/session', async (request, response) => {
    const cookies = parseCookies(request);
    const signed = cookies[SESSION_COOKIE_NAME];
    const sessionId =
      signed === undefined ? undefined : verifySignedSessionId(signed, options.cookieSecret);
    const session = sessionId === undefined ? undefined : await store.get(sessionId);
    if (session === undefined) {
      response.json({ authenticated: false });
      return;
    }
    const claims = await claimsWithStoredIdentity(session.claims, options.userStore);
    if (claims !== session.claims) {
      await store.set({ ...session, claims });
    }
    publicSessionResponse(response, { ...session, claims });
  });

  return store;
}

/** Build Firebase auth settings from Render/local environment variables. */
export function firebaseAuthOptionsFromEnv(): FirebaseAuthOptions | undefined {
  const enabled = process.env.FIREBASE_AUTH_ENABLED?.toLowerCase() === 'true';
  if (!enabled) return undefined;

  const cookieSecret = process.env.SESSION_SECRET?.trim();
  if (cookieSecret === undefined || cookieSecret.length < 32) {
    throw new Error('FIREBASE_AUTH_ENABLED requires SESSION_SECRET of at least 32 characters');
  }

  const configuredRole = process.env.FIREBASE_DEFAULT_ROLE?.trim();
  const roleRaw = configuredRole === undefined || configuredRole.length === 0
    ? DEFAULT_ROLE
    : configuredRole;
  const knownRoles = new Set<string>(AUTHORIZATION_ROLES as readonly string[]);
  knownRoles.add('hiring-manager');
  if (!knownRoles.has(roleRaw)) {
    throw new Error(`Invalid FIREBASE_DEFAULT_ROLE: ${roleRaw}`);
  }
  const defaultRole = roleRaw as AuthorizationRole;

  return {
    cookieSecret,
    secureCookie: process.env.NODE_ENV === 'production',
    projectId:
      process.env.FIREBASE_PROJECT_ID?.trim() || undefined,
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT?.trim() || undefined,
    credentialsPath:
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || undefined,
    defaultTenantId:
      process.env.FIREBASE_DEFAULT_TENANT_ID?.trim() || DEFAULT_TENANT,
    defaultRole
  };
}

export function createFirebaseSessionResolver(options: FirebaseAuthOptions) {
  return createWebSessionResolver({
    cookieSecret: options.cookieSecret,
    store: options.store,
    resolveClaims: (claims) => claimsWithStoredIdentity(claims, options.userStore)
  });
}
