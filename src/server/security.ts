/**
 * Abuse-protection and transport-safety middleware for PipelineOS.
 *
 * Exposing `/api/*` and `/mcp` to the public internet — and to an LLM host
 * such as a ChatGPT connector that autonomously chooses and calls tools —
 * means the transport must defend itself before a request ever reaches the
 * operation boundary. This module centralizes:
 *
 *   - Security headers (helmet), tuned so they do not break the SPA or the
 *     existing WebMCP eligibility headers.
 *   - A CORS allowlist (same-origin by default; extra origins via env).
 *   - A request body size cap.
 *   - Rate limiting keyed by the resolved principal (subject/tenant) when
 *     available, falling back to client IP, applied to the operation and MCP
 *     surfaces. Read-heavy discovery is not the concern; unbounded mutation
 *     attempts and brute force are.
 *
 * Everything is configurable through environment variables with safe defaults,
 * and every knob can be overridden programmatically by a composition root.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';

import { RateLimitedError } from '../shared/errors';

export interface SecurityOptions {
  /** Max JSON body size (e.g. "256kb"). Env: REQUEST_BODY_LIMIT. */
  bodyLimit?: string;
  /** Allowed CORS origins. Env: CORS_ALLOWED_ORIGINS (comma-separated). */
  corsAllowedOrigins?: readonly string[];
  /** Rate-limit window in ms. Env: RATE_LIMIT_WINDOW_MS. Default 60000. */
  rateLimitWindowMs?: number;
  /** Max requests per key per window. Env: RATE_LIMIT_MAX. Default 120. */
  rateLimitMax?: number;
  /** Disable rate limiting entirely (tests). Env: RATE_LIMIT_DISABLED=true. */
  rateLimitDisabled?: boolean;
  /** Enable helmet. Default true. */
  helmet?: boolean;
}

const DEFAULT_BODY_LIMIT = '256kb';
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120;

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Resolve the effective request body size limit. */
export function resolveBodyLimit(options: SecurityOptions = {}): string {
  return (
    options.bodyLimit ?? process.env.REQUEST_BODY_LIMIT ?? DEFAULT_BODY_LIMIT
  );
}

/**
 * Build the helmet middleware. `contentSecurityPolicy` is disabled by default
 * because the SPA and Vite dev server inline scripts/styles; a deployment that
 * wants a strict CSP can layer its own. Cross-origin resource policy is relaxed
 * to same-site so static assets and the API can be served from one origin.
 */
export function createSecurityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' }
  });
}

/** Build the CORS middleware from an allowlist. Same-origin needs no entry. */
export function createCorsMiddleware(options: SecurityOptions = {}): RequestHandler {
  const allowed = options.corsAllowedOrigins ?? envList('CORS_ALLOWED_ORIGINS') ?? [];
  const allowedSet = new Set(allowed);
  return cors({
    origin(origin, callback) {
      // No Origin header (same-origin, curl, server-to-server) is allowed.
      if (origin === undefined || allowedSet.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-Id',
      'X-Actor-Type',
      'X-Actor-Id',
      'Mcp-Session-Id'
    ]
  });
}

/**
 * Derive the rate-limit key. A verified principal is the strongest signal, so
 * we key by tenant + subject when the auth layer has populated `request.auth`
 * (MCP bearer) — this throttles a single connector/user rather than a shared
 * egress IP. Otherwise we fall back to the client IP.
 */
export function rateLimitKey(request: Request): string {
  const claims = (request as { auth?: { extra?: { claims?: unknown } } }).auth?.extra
    ?.claims as { subject?: string; tenantId?: string } | undefined;
  if (claims?.subject !== undefined) {
    return `principal:${claims.tenantId ?? 'unknown'}:${claims.subject}`;
  }
  // Actor headers are presentation-only and untrusted, but they still let us
  // separate distinct demo actors behind one IP in non-production.
  const actorId = request.header('x-actor-id');
  const actorType = request.header('x-actor-type');
  if (actorId !== undefined && actorType !== undefined) {
    return `actor:${actorType}:${actorId}`;
  }
  return `ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;
}

/** Build the rate-limit middleware, keyed per-principal with an IP fallback. */
export function createRateLimiter(options: SecurityOptions = {}): RequestHandler {
  const windowMs =
    options.rateLimitWindowMs ??
    envInt('RATE_LIMIT_WINDOW_MS') ??
    DEFAULT_RATE_LIMIT_WINDOW_MS;
  const max =
    options.rateLimitMax ?? envInt('RATE_LIMIT_MAX') ?? DEFAULT_RATE_LIMIT_MAX;

  const limiterOptions: Partial<RateLimitOptions> = {
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    handler: (_request: Request, response: Response) => {
      const error = new RateLimitedError(
        'Too many requests. Please slow down and retry shortly.'
      );
      response.status(error.status).json(error.toPayload());
    }
  };
  return rateLimit(limiterOptions);
}

function rateLimitingEnabled(options: SecurityOptions): boolean {
  if (options.rateLimitDisabled === true) return false;
  if (process.env.RATE_LIMIT_DISABLED === 'true') return false;
  return true;
}

/**
 * Install global security middleware on the app in the correct order:
 * security headers first, then CORS. Body parsing and the rate limiter are
 * mounted by the API factory (the body cap wraps `express.json`, and the rate
 * limiter is scoped to the operation/MCP paths), so this only owns the
 * always-on header/CORS layer.
 */
export function installGlobalSecurity(
  app: Express,
  options: SecurityOptions = {}
): void {
  if (options.helmet !== false) {
    app.use(createSecurityHeaders());
  }
  app.use(createCorsMiddleware(options));
}

/**
 * Return the rate limiter to mount on the sensitive routes, or undefined when
 * rate limiting is disabled (e.g. in the test environment).
 */
export function operationRateLimiter(
  options: SecurityOptions = {}
): RequestHandler | undefined {
  if (!rateLimitingEnabled(options)) return undefined;
  return createRateLimiter(options);
}
