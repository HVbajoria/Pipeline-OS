/**
 * Web (browser) OIDC login for human recruiters, candidates, and hiring
 * managers. This is the interactive counterpart to the MCP bearer path: a user
 * signs in through the organization's identity provider, and the resulting
 * session maps to the same TrustedPrincipal via `principalInputFromClaims`.
 *
 * The flow is standard OpenID Connect Authorization Code + PKCE:
 *   GET  /auth/login    -> redirect to the IdP authorize endpoint
 *   GET  /auth/callback -> exchange the code, verify the ID token, open a session
 *   POST /auth/logout   -> clear the session
 *   GET  /auth/session  -> report the current session identity (no secrets)
 *
 * The OIDC network calls (authorize URL construction and code exchange) are
 * injected through an `OidcWebClient` so this module stays dependency-light and
 * unit-testable; a production host wires in a real client (for example using
 * `openid-client`). Sessions are held in an injectable store (in-memory by
 * default) keyed by an HMAC-signed, httpOnly cookie.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';

import {
  createTrustedPrincipal,
  type TrustedPrincipal
} from '../authorization';
import {
  principalInputFromClaims,
  type VerifiedIdentityClaims
} from './identityClaims';

export const SESSION_COOKIE_NAME = 'pipelineos_session';

/** One authenticated browser session. */
export interface WebSession {
  sessionId: string;
  claims: VerifiedIdentityClaims;
  createdAt: number;
  expiresAt: number;
}

export interface WebSessionStore {
  get(sessionId: string): WebSession | undefined | Promise<WebSession | undefined>;
  set(session: WebSession): void | Promise<void>;
  delete(sessionId: string): void | Promise<void>;
}

/** Default in-memory session store; a durable host injects its own. */
export class InMemoryWebSessionStore implements WebSessionStore {
  private readonly sessions = new Map<string, WebSession>();

  get(sessionId: string): WebSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  set(session: WebSession): void {
    this.sessions.set(session.sessionId, session);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Parameters the login route hands to the OIDC client to start the flow. */
export interface OidcAuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

/** The verified result of exchanging an authorization code. */
export interface OidcCodeExchangeResult {
  claims: VerifiedIdentityClaims;
  /** Optional session lifetime in seconds; defaults to the store default. */
  expiresIn?: number;
}

/**
 * Injected OIDC client. `authorizationUrl` builds the IdP redirect;
 * `exchangeCode` performs the token exchange and returns verified claims.
 */
export interface OidcWebClient {
  authorizationUrl(request: OidcAuthorizationRequest): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OidcCodeExchangeResult>;
}

export interface WebAuthOptions {
  client: OidcWebClient;
  /** Secret used to sign the session cookie. Must be strong in production. */
  cookieSecret: string;
  /** Absolute redirect URI registered with the IdP for /auth/callback. */
  redirectUri: string;
  store?: WebSessionStore;
  /** Session lifetime in ms (default 8h). */
  sessionTtlMs?: number;
  /** Mark the cookie Secure (default true; disable only for local http). */
  secureCookie?: boolean;
  /** Where to send the browser after a successful login (default "/"). */
  postLoginRedirect?: string;
}

interface PendingLogin {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function base64Url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(value: string, secret: string): string {
  return base64Url(createHmac('sha256', secret).update(value).digest());
}

/** Build the signed cookie value `<sessionId>.<hmac>`. */
export function signSessionId(sessionId: string, secret: string): string {
  return `${sessionId}.${sign(sessionId, secret)}`;
}

/** Verify and extract a session id from a signed cookie value. */
export function verifySignedSessionId(
  signed: string,
  secret: string
): string | undefined {
  const separator = signed.lastIndexOf('.');
  if (separator <= 0) return undefined;
  const sessionId = signed.slice(0, separator);
  const providedSig = signed.slice(separator + 1);
  const expectedSig = sign(sessionId, secret);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return undefined;
  return timingSafeEqual(provided, expected) ? sessionId : undefined;
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0) result[name] = decodeURIComponent(value);
  }
  return result;
}

export function setSessionCookie(
  response: Response,
  value: string,
  maxAgeMs: number,
  secure: boolean
): void {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) attributes.push('Secure');
  response.append('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0'
  ];
  if (secure) attributes.push('Secure');
  response.append('Set-Cookie', attributes.join('; '));
}

/**
 * Resolve the current browser session's TrustedPrincipal, or undefined when
 * there is no valid session. This is used by the request-identity path so the
 * web UI is authorized exactly like every other surface.
 */
export function createWebSessionResolver(
  options: Pick<WebAuthOptions, 'cookieSecret' | 'store'>
): (
  request: Request
) => Promise<TrustedPrincipal | undefined> {
  const store = options.store ?? new InMemoryWebSessionStore();
  return async (request: Request) => {
    const cookies = parseCookies(request);
    const signed = cookies[SESSION_COOKIE_NAME];
    if (signed === undefined) return undefined;
    const sessionId = verifySignedSessionId(signed, options.cookieSecret);
    if (sessionId === undefined) return undefined;
    const session = await store.get(sessionId);
    if (session === undefined) return undefined;
    try {
      return createTrustedPrincipal(principalInputFromClaims(session.claims));
    } catch {
      return undefined;
    }
  };
}

/**
 * Mount the web auth routes. Returns the shared session store so the same
 * instance can back `createWebSessionResolver`.
 */
export function installWebAuthRoutes(
  app: Express,
  options: WebAuthOptions
): WebSessionStore {
  const store = options.store ?? new InMemoryWebSessionStore();
  const secureCookie = options.secureCookie ?? true;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const pending = new Map<string, PendingLogin>();

  const prunePending = (): void => {
    const now = Date.now();
    for (const [key, entry] of pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(key);
    }
  };

  const login: RequestHandler = (request, response) => {
    prunePending();
    const state = base64Url(randomBytes(24));
    const codeVerifier = base64Url(randomBytes(32));
    const codeChallenge = base64Url(
      createHmac('sha256', codeVerifier).update(codeVerifier).digest()
    );
    pending.set(state, { state, codeVerifier, createdAt: Date.now() });
    const url = options.client.authorizationUrl({
      state,
      codeChallenge,
      redirectUri: options.redirectUri
    });
    response.redirect(url);
  };

  const callback: RequestHandler = async (request, response) => {
    try {
      const code = typeof request.query.code === 'string' ? request.query.code : undefined;
      const state = typeof request.query.state === 'string' ? request.query.state : undefined;
      if (code === undefined || state === undefined) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }
      const pendingLogin = pending.get(state);
      pending.delete(state);
      if (pendingLogin === undefined) {
        response.status(400).json({ error: 'invalid_state' });
        return;
      }

      const result = await options.client.exchangeCode({
        code,
        codeVerifier: pendingLogin.codeVerifier,
        redirectUri: options.redirectUri
      });

      const now = Date.now();
      const ttlMs =
        result.expiresIn !== undefined ? result.expiresIn * 1000 : sessionTtlMs;
      const sessionId = base64Url(randomBytes(24));
      const session: WebSession = {
        sessionId,
        claims: result.claims,
        createdAt: now,
        expiresAt: now + ttlMs
      };
      await store.set(session);
      setSessionCookie(
        response,
        signSessionId(sessionId, options.cookieSecret),
        ttlMs,
        secureCookie
      );
      response.redirect(options.postLoginRedirect ?? '/');
    } catch {
      response.status(401).json({ error: 'authentication_failed' });
    }
  };

  const logout: RequestHandler = async (request, response) => {
    const cookies = parseCookies(request);
    const signed = cookies[SESSION_COOKIE_NAME];
    if (signed !== undefined) {
      const sessionId = verifySignedSessionId(signed, options.cookieSecret);
      if (sessionId !== undefined) await store.delete(sessionId);
    }
    clearSessionCookie(response, secureCookie);
    response.json({ success: true });
  };

  const sessionInfo: RequestHandler = async (request, response) => {
    const cookies = parseCookies(request);
    const signed = cookies[SESSION_COOKIE_NAME];
    const sessionId =
      signed === undefined ? undefined : verifySignedSessionId(signed, options.cookieSecret);
    const session = sessionId === undefined ? undefined : await store.get(sessionId);
    if (session === undefined) {
      response.json({ authenticated: false });
      return;
    }
    // Return only safe, display-oriented identity fields; never secrets.
    response.json({
      authenticated: true,
      subject: session.claims.subject,
      tenantId: session.claims.tenantId,
      roles: session.claims.roles,
      ...(session.claims.email === undefined ? {} : { email: session.claims.email })
    });
  };

  app.get('/auth/login', login);
  app.get('/auth/callback', callback);
  app.post('/auth/logout', logout);
  app.get('/auth/session', sessionInfo);

  return store;
}
