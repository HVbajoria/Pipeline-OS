import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  PipelineError,
  RateLimitedError,
  serializePipelineError,
  statusForErrorCode,
  UpstreamError,
  upstreamError,
  forbiddenError,
  rateLimitedError
} from '../src/shared/errors';
import type { GitHubProspectSearchResult } from '../src/shared/operations';
import {
  OPERATION_IMPLEMENTATION_KEYS,
  OPERATION_NAMES,
  OPERATION_REGISTRY
} from '../src/shared/operations';
import {
  GITHUB_PROSPECT_FILTER_MAX_LENGTH,
  GITHUB_PROSPECT_QUERY_MAX_LENGTH
} from '../src/shared/publicProspects';
import {
  validateOperationInput,
  validateOperationOutput
} from '../src/shared/validators';

const PUBLIC_OPERATION = 'search_public_candidates' as const;

const validOutput: GitHubProspectSearchResult = {
  prospects: [
    {
      source: 'github',
      sourceUrl: 'https://github.com/octocat',
      profileUrl: 'https://github.com/octocat',
      username: 'octocat',
      login: 'octocat',
      profileType: 'User',
      searchScore: 42.75,
      query: 'typescript language:TypeScript',
      fetchedAt: '2026-04-01T12:00:00.000Z',
      dataOrigin: 'public_github',
      consentStatus: 'not_provided',
      location: 'San Francisco',
      bio: 'Builds public software',
      publicRepos: 8
    }
  ],
  query: 'typescript language:TypeScript',
  filters: { query: 'typescript', language: 'TypeScript' },
  source: 'github',
  fetchedAt: '2026-04-01T12:00:00.000Z',
  cache: {
    hit: false,
    coalesced: false,
    ageMs: 0,
    ttlMs: 300000,
    fetchedAt: '2026-04-01T12:00:00.000Z',
    expiresAt: '2026-04-01T12:05:00.000Z'
  },
  attribution: {
    source: 'github',
    apiUrl: 'https://api.github.com/search/users',
    searchApiDocsUrl: 'https://docs.github.com/en/rest/search/search',
    rateLimitsDocsUrl:
      'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
    userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
  }
};

describe('search_public_candidates shared operation contract', () => {
  it('is the twentieth canonical operation and does not alter persisted search_candidates', () => {
    expect(OPERATION_NAMES.slice(0, 20)).toContain(PUBLIC_OPERATION);
    expect(OPERATION_IMPLEMENTATION_KEYS[PUBLIC_OPERATION]).toBe(
      'searchPublicCandidates'
    );
    const descriptor = OPERATION_REGISTRY[PUBLIC_OPERATION];
    expect(OPERATION_REGISTRY.search_candidates).not.toBe(descriptor);
    expect(OPERATION_REGISTRY.search_candidates.inputSchema.properties).toEqual(
      expect.objectContaining({ experienceLevel: expect.any(Object) })
    );
    expect(descriptor.readOnly).toBe(true);
    expect(descriptor.readOnlyHint).toBe(true);
    expect(descriptor.annotations).toEqual({
      readOnlyHint: true,
      executionClass: descriptor.executionClass,
      requiresApproval: descriptor.approvalPolicy !== 'none',
      planable: descriptor.planable
    });
    expect(descriptor.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false
    });
    expect(Object.keys(descriptor.inputSchema.properties ?? {}).sort()).toEqual([
      'language',
      'location',
      'query'
    ]);
    expect(descriptor.inputSchema.properties?.query).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: GITHUB_PROSPECT_QUERY_MAX_LENGTH
    });
    expect(descriptor.inputSchema.properties?.language).toMatchObject({
      type: 'string',
      maxLength: GITHUB_PROSPECT_FILTER_MAX_LENGTH
    });
    expect(descriptor.inputSchema.properties?.location).toMatchObject({
      type: 'string',
      maxLength: GITHUB_PROSPECT_FILTER_MAX_LENGTH
    });
    expect(descriptor.inputSchema.properties).not.toHaveProperty('experienceLevel');
    expect(descriptor.inputSchema.properties).not.toHaveProperty('maxResults');
    expect(descriptor.outputSchema.required).toEqual([
      'prospects',
      'query',
      'filters',
      'source',
      'fetchedAt',
      'cache',
      'attribution'
    ]);
    expect(OPERATION_REGISTRY.search_candidates.inputSchema.properties).toEqual(
      expect.objectContaining({ experienceLevel: expect.any(Object) })
    );
  });

  it('normalizes valid filters and omits blank optional values before handlers receive input', () => {
    expect(
      validateOperationInput(PUBLIC_OPERATION, {
        query: '  backend   engineer  ',
        language: '   ',
        location: '  New   York '
      })
    ).toEqual({
      query: 'backend engineer',
      location: 'New York'
    });
  });

  it('rejects malformed, unsafe, overlong, and unknown public-search input', () => {
    const overlongQuery = 'q'.repeat(GITHUB_PROSPECT_QUERY_MAX_LENGTH + 1);
    const overlongFilter = 'x'.repeat(GITHUB_PROSPECT_FILTER_MAX_LENGTH + 1);
    const invalidInputs: unknown[] = [
      undefined,
      {},
      { query: '   ' },
      { query: overlongQuery },
      { query: 'backend\nengineer' },
      { query: 'backend', language: overlongFilter },
      { query: 'backend', location: 'New\tYork' },
      { query: 'backend', experienceLevel: 'senior' },
      { query: 'backend', maxResults: 10 },
      { query: 'backend', unsupported: true }
    ];

    for (const input of invalidInputs) {
      try {
        validateOperationInput(PUBLIC_OPERATION, input);
        throw new Error(`Expected validation to reject ${JSON.stringify(input)}`);
      } catch (error) {
        const pipelineError = PipelineError.from(error);
        expect(pipelineError.code).toBe('VALIDATION_ERROR');
        expect(pipelineError.status).toBe(400);
      }
    }
  });

  it('validates the complete allowlisted result shape without server-only types', () => {
    expect(validateOperationOutput(PUBLIC_OPERATION, validOutput)).toEqual(
      validOutput
    );
    expect(() =>
      validateOperationOutput(PUBLIC_OPERATION, {
        ...validOutput,
        token: 'must-not-be-part-of-the-contract'
      })
    ).toThrowError(/invalid output/i);
  });
});

describe('public-prospect structured error mapping', () => {
  it('serializes forbidden, rate-limited, and upstream errors with canonical statuses', () => {
    const cases = [
      [forbiddenError('Recruiter access required'), ForbiddenError, 'FORBIDDEN_ERROR', 403],
      [
        rateLimitedError('GitHub rate limit reached', {
          source: 'github',
          retryAfterSeconds: 30
        }),
        RateLimitedError,
        'RATE_LIMITED_ERROR',
        429
      ],
      [
        upstreamError('GitHub service unavailable', {
          source: 'github',
          upstreamStatus: 503
        }),
        UpstreamError,
        'UPSTREAM_ERROR',
        502
      ]
    ] as const;

    for (const [error, errorClass, code, status] of cases) {
      expect(error).toBeInstanceOf(errorClass);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(serializePipelineError(error)).toEqual({
        error: {
          code,
          status,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      });
      expect(PipelineError.from(error.toPayload()).toPayload()).toEqual(
        error.toPayload()
      );
      expect(statusForErrorCode(code)).toBe(status);
    }
  });

  it('does not expose token-like values through the shared error serializer', () => {
    const error = new UpstreamError('GitHub service unavailable', {
      source: 'github',
      retryAfterSeconds: 30
    });
    const serialized = JSON.stringify(error.toPayload());
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('Authorization');
  });
});
