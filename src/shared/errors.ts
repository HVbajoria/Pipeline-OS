/** Structured, JSON-safe errors shared by HTTP, UI, and WebMCP adapters. */

export type PipelineErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND_ERROR'
  | 'CONFLICT_ERROR'
  | 'FORBIDDEN_ERROR'
  | 'RATE_LIMITED_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

export type PipelineErrorStatus = 400 | 403 | 404 | 409 | 429 | 500 | 502;

export const PIPELINE_ERROR_DETAIL_REASONS = [
  'stale_revision',
  'entity_changed',
  'approval_required',
  'plan_expired',
  'approval_rejected',
  'idempotency_key_reuse',
  'already_withdrawn',
  'capability_denied',
  'resource_scope',
  'consent_required',
  'approval_principal_required',
  'not_authenticated',
  'metadata_invalid',
  'consent_invalid',
  'unsupported_mode',
  'input_invalid',
  'approval_not_found',
  'record_not_found',
  'trace_not_found',
  'operation_timeout'
] as const;
export type PipelineErrorDetailReason =
  (typeof PIPELINE_ERROR_DETAIL_REASONS)[number];
export type PipelineErrorReason = PipelineErrorDetailReason;
export type PipelineErrorDetailsReason = PipelineErrorDetailReason;

export type PipelineConflictReason =
  | 'stale_revision'
  | 'entity_changed'
  | 'approval_required'
  | 'plan_expired'
  | 'approval_rejected'
  | 'idempotency_key_reuse'
  | 'already_withdrawn';
export type PipelineForbiddenReason =
  | 'capability_denied'
  | 'resource_scope'
  | 'consent_required'
  | 'approval_principal_required'
  | 'not_authenticated';
export type PipelineValidationReason =
  | 'metadata_invalid'
  | 'consent_invalid'
  | 'unsupported_mode'
  | 'input_invalid';
export type PipelineNotFoundReason =
  | 'approval_not_found'
  | 'record_not_found'
  | 'trace_not_found';

export interface PipelineErrorDetails {
  field?: string;
  recordType?: string;
  recordId?: string;
  reason?: PipelineErrorDetailReason;
  expectedRevision?: number;
  currentRevision?: number;
  operationName?: string;
  approvalId?: string;
  originalActivityId?: string;
  traceId?: string;
  requiredCapability?: string;
  resourceScope?: string;
  retryAction?: string;
  /** Individual schema/field failures, retained for clients that need detail. */
  issues?: readonly PipelineValidationIssue[];
  [key: string]: unknown;
}

export interface PipelineValidationIssue {
  path: string;
  message: string;
  keyword?: string;
}

export interface PipelineErrorObject {
  code: PipelineErrorCode;
  status: PipelineErrorStatus;
  message: string;
  details?: PipelineErrorDetails;
}

/** The stable envelope returned by the API and WebMCP handlers. */
export interface PipelineErrorPayload {
  error: PipelineErrorObject;
}

export interface PipelineErrorInit {
  code: PipelineErrorCode;
  /** Optional for callers constructing a payload; code remains authoritative. */
  status?: PipelineErrorStatus;
  message: string;
  details?: PipelineErrorDetails;
}

const STATUS_BY_CODE: Readonly<Record<PipelineErrorCode, PipelineErrorStatus>> = {
  VALIDATION_ERROR: 400,
  FORBIDDEN_ERROR: 403,
  NOT_FOUND_ERROR: 404,
  CONFLICT_ERROR: 409,
  RATE_LIMITED_ERROR: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502
};

function isPipelineErrorCode(value: unknown): value is PipelineErrorCode {
  return (
    value === 'VALIDATION_ERROR' ||
    value === 'FORBIDDEN_ERROR' ||
    value === 'NOT_FOUND_ERROR' ||
    value === 'CONFLICT_ERROR' ||
    value === 'RATE_LIMITED_ERROR' ||
    value === 'UPSTREAM_ERROR' ||
    value === 'INTERNAL_ERROR'
  );
}

/**
 * Error object used throughout the shared operation path.  The HTTP status is
 * derived from the stable code so an adapter cannot accidentally drift from
 * the canonical contract.
 */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly status: PipelineErrorStatus;
  readonly details?: PipelineErrorDetails;

  constructor(init: PipelineErrorInit);
  constructor(
    code: PipelineErrorCode,
    message: string,
    details?: PipelineErrorDetails
  );
  constructor(
    code: PipelineErrorCode,
    status: PipelineErrorStatus,
    message: string,
    details?: PipelineErrorDetails
  );
  constructor(
    initOrCode: PipelineErrorInit | PipelineErrorCode,
    messageOrStatus?: string | PipelineErrorStatus,
    messageOrDetails?: string | PipelineErrorDetails,
    details?: PipelineErrorDetails
  ) {
    const init: PipelineErrorInit =
      typeof initOrCode === 'string'
        ? {
            code: initOrCode,
            status:
              typeof messageOrStatus === 'number'
                ? messageOrStatus
                : undefined,
            message:
              typeof messageOrStatus === 'string'
                ? messageOrStatus
                : typeof messageOrDetails === 'string'
                  ? messageOrDetails
                  : 'Pipeline operation failed',
            details:
              typeof messageOrStatus === 'number'
                ? details
                : typeof messageOrDetails === 'object'
                  ? messageOrDetails
                  : details
          }
        : initOrCode;

    const canonicalStatus = STATUS_BY_CODE[init.code];
    // A caller may supply a status for readability, but never change the
    // status associated with a structured error code.
    super(init.message);
    this.name = 'PipelineError';
    this.code = init.code;
    this.status = canonicalStatus;
    this.details = init.details;

    // Required when targeting transpilation modes that do not preserve Error
    // subclass prototypes automatically.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toErrorObject(): PipelineErrorObject {
    const result: PipelineErrorObject = {
      code: this.code,
      status: this.status,
      message: this.message
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }

  toPayload(): PipelineErrorPayload {
    return { error: this.toErrorObject() };
  }

  /** JSON.stringify(Error) uses this method, preserving the API envelope. */
  toJSON(): PipelineErrorPayload {
    return this.toPayload();
  }

  static from(error: unknown): PipelineError {
    if (error instanceof PipelineError) {
      return error;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'error' in error
    ) {
      const payload = error as Partial<PipelineErrorPayload>;
      const value = payload.error;
      if (
        value &&
        isPipelineErrorCode(value.code) &&
        typeof value.message === 'string'
      ) {
        return new PipelineError({
          code: value.code,
          status: value.status,
          message: value.message,
          details: value.details
        });
      }
    }

    return new InternalError('Internal server error');
  }
}

export class ValidationError extends PipelineError {
  constructor(message = 'Input validation failed', details?: PipelineErrorDetails) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends PipelineError {
  constructor(message = 'Requested record was not found', details?: PipelineErrorDetails) {
    super('NOT_FOUND_ERROR', message, details);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends PipelineError {
  constructor(message = 'Operation conflicts with the current state', details?: PipelineErrorDetails) {
    super('CONFLICT_ERROR', message, details);
    this.name = 'ConflictError';
  }
}

export class ForbiddenError extends PipelineError {
  constructor(message = 'You do not have permission to perform this action', details?: PipelineErrorDetails) {
    super('FORBIDDEN_ERROR', message, details);
    this.name = 'ForbiddenError';
  }
}

export class RateLimitedError extends PipelineError {
  constructor(message = 'The upstream service rate limit was reached', details?: PipelineErrorDetails) {
    super('RATE_LIMITED_ERROR', message, details);
    this.name = 'RateLimitedError';
  }
}

export class UpstreamError extends PipelineError {
  constructor(message = 'The upstream service returned an error', details?: PipelineErrorDetails) {
    super('UPSTREAM_ERROR', message, details);
    this.name = 'UpstreamError';
  }
}

export function forbiddenError(
  message = 'You do not have permission to perform this action',
  details?: PipelineErrorDetails
): ForbiddenError {
  return new ForbiddenError(message, details);
}

export function rateLimitedError(
  message = 'The upstream service rate limit was reached',
  details?: PipelineErrorDetails
): RateLimitedError {
  return new RateLimitedError(message, details);
}

export function upstreamError(
  message = 'The upstream service returned an error',
  details?: PipelineErrorDetails
): UpstreamError {
  return new UpstreamError(message, details);
}

export class InternalError extends PipelineError {
  constructor(message = 'Internal server error', details?: PipelineErrorDetails) {
    super('INTERNAL_ERROR', message, details);
    this.name = 'InternalError';
  }
}

export function validationError(
  message = 'Input validation failed',
  details?: PipelineErrorDetails
): ValidationError {
  return new ValidationError(message, details);
}

export function notFoundError(
  message = 'Requested record was not found',
  details?: PipelineErrorDetails
): NotFoundError {
  return new NotFoundError(message, details);
}

export function conflictError(
  message = 'Operation conflicts with the current state',
  details?: PipelineErrorDetails
): ConflictError {
  return new ConflictError(message, details);
}

export function internalError(
  message = 'Internal server error',
  details?: PipelineErrorDetails
): InternalError {
  return new InternalError(message, details);
}

export function isPipelineError(error: unknown): error is PipelineError {
  return error instanceof PipelineError;
}

/** Convert any thrown value to the one public structured error envelope. */
export function serializePipelineError(error: unknown): PipelineErrorPayload {
  return PipelineError.from(error).toPayload();
}

/** Return the inner error object when an adapter needs a non-enveloped value. */
export function serializePipelineErrorObject(
  error: unknown
): PipelineErrorObject {
  return PipelineError.from(error).toErrorObject();
}

export function statusForErrorCode(code: PipelineErrorCode): PipelineErrorStatus {
  return STATUS_BY_CODE[code];
}
