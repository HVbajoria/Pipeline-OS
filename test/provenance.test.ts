import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/shared/errors';
import {
  assertPublicProspectConsentUsable,
  canonicalizePublicProspectSourceReference,
  evaluatePublicProspectConsent,
  getPublicProspectRetentionStatus,
  isPublicProspectRetentionActive,
  normalizePublicProspectConsent,
  normalizePublicProspectFieldOrigins
} from '../src/shared/domain/provenance';
import type {
  PublicProspectConsent,
  PublicProspectSourceReference,
  SourcedProspectRecord
} from '../src/shared/publicProspects';

const NOW = '2026-04-01T12:00:00.000Z';

const sourceReference: PublicProspectSourceReference = {
  source: 'github',
  sourceRecordId: 'octocat',
  profileUrl: 'HTTPS://GITHUB.COM/octocat/#profile',
  canonicalSourceUrl: 'https://api.github.com/users/octocat/',
  sourceQuery: '  backend   language:TypeScript  ',
  sourceFilters: { language: '  TypeScript ', location: ' Berlin ' },
  fetchedAt: '2026-04-01T15:00:00+03:00',
  attribution: {
    source: 'github',
    apiUrl: 'https://api.github.com/',
    searchApiDocsUrl: 'https://docs.github.com/en/rest/search#search',
    rateLimitsDocsUrl: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits',
    userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
  }
};

const consent: PublicProspectConsent = {
  method: 'approved_consent_channel',
  scope: 'candidate-profile-import',
  capturedAt: NOW,
  capturedBy: { actorType: 'human_ui', actorId: 'recruiter-1' },
  evidenceRef: 'consent-record-1',
  policyVersion: 'p11.4.v1'
};

function consentRecord(
  overrides: Partial<SourcedProspectRecord> = {}
): Pick<SourcedProspectRecord, 'consentStatus' | 'consent' | 'retentionExpiresAt'> {
  return {
    consentStatus: 'explicit',
    consent,
    retentionExpiresAt: '2026-05-01T00:00:00.000Z',
    ...overrides
  };
}

describe('pure public-prospect provenance rules', () => {
  it('canonicalizes source references without changing public-search contracts', () => {
    const original = structuredClone(sourceReference);
    const normalized = canonicalizePublicProspectSourceReference(sourceReference);

    expect(normalized).toEqual({
      source: 'github',
      sourceRecordId: 'octocat',
      profileUrl: 'https://github.com/octocat',
      canonicalSourceUrl: 'https://api.github.com/users/octocat',
      sourceQuery: 'backend language:TypeScript',
      sourceFilters: { language: 'TypeScript', location: 'Berlin' },
      fetchedAt: NOW,
      attribution: {
        source: 'github',
        apiUrl: 'https://api.github.com/',
        searchApiDocsUrl: 'https://docs.github.com/en/rest/search',
        rateLimitsDocsUrl: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits',
        userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
      }
    });
    expect(sourceReference).toEqual(original);
    expect(canonicalizePublicProspectSourceReference(sourceReference)).toEqual(normalized);
  });

  it('rejects unsafe, unknown, and non-allowlisted provenance fields', () => {
    expect(() =>
      canonicalizePublicProspectSourceReference({
        ...sourceReference,
        profileUrl: 'https://evil.example.test/octocat'
      })
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizePublicProspectSourceReference({
        ...sourceReference,
        sourceQuery: 'backend\nengineer'
      })
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizePublicProspectSourceReference({
        ...sourceReference,
        unexpected: true
      })
    ).toThrow(ValidationError);
    expect(() =>
      canonicalizePublicProspectSourceReference({
        ...sourceReference,
        canonicalSourceUrl: 'https://octocat:password@api.github.com/users/octocat'
      })
    ).toThrow(ValidationError);
  });

  it('validates and canonicalizes per-field origins with optional manifests', () => {
    const origins = normalizePublicProspectFieldOrigins(
      {
        resumeText: 'candidate_submitted',
        sourceRecordId: 'github_public',
        name: 'candidate_submitted'
      },
      {
        requiredFields: ['name', 'sourceRecordId'],
        expectedOrigins: { sourceRecordId: 'github_public' }
      }
    );

    expect(Object.keys(origins)).toEqual(['name', 'resumeText', 'sourceRecordId']);
    expect(origins).toEqual({
      name: 'candidate_submitted',
      resumeText: 'candidate_submitted',
      sourceRecordId: 'github_public'
    });
    expect(() =>
      normalizePublicProspectFieldOrigins(
        { name: 'github_public' },
        { expectedOrigins: { name: 'candidate_submitted' } }
      )
    ).toThrow(ValidationError);
    expect(() =>
      normalizePublicProspectFieldOrigins({ name: 'private_database' })
    ).toThrow(ValidationError);
  });

  it('normalizes safe consent metadata and evaluates retention at an injected boundary', () => {
    const normalizedConsent = normalizePublicProspectConsent({
      ...consent,
      scope: ' candidate-profile-import ',
      policyVersion: ' p11.4.v1 '
    });
    expect(normalizedConsent).toEqual(consent);
    expect(isPublicProspectRetentionActive('2026-05-01T00:00:00.000Z', NOW)).toBe(true);
    expect(isPublicProspectRetentionActive('2026-04-01T12:00:00.000Z', NOW)).toBe(false);
    expect(getPublicProspectRetentionStatus('not-a-date', NOW)).toBe('invalid');

    expect(
      evaluatePublicProspectConsent(consentRecord(), {
        now: NOW,
        requiredScope: 'candidate-profile-import',
        policyVersion: 'p11.4.v1'
      })
    ).toMatchObject({ allowed: true, status: 'explicit', reason: 'allowed' });
    expect(
      evaluatePublicProspectConsent(consentRecord(), '2026-05-01T00:00:00.000Z')
    ).toMatchObject({ allowed: false, status: 'expired', reason: 'retention_expired' });
    expect(
      evaluatePublicProspectConsent(
        consentRecord({ consentStatus: 'withdrawn' }),
        NOW
      )
    ).toMatchObject({ allowed: false, status: 'withdrawn', reason: 'withdrawn' });
    expect(
      evaluatePublicProspectConsent(
        consentRecord({ consentStatus: 'not_provided', consent: null }),
        NOW
      )
    ).toMatchObject({ allowed: false, status: 'not_provided', reason: 'not_provided' });
    expect(
      evaluatePublicProspectConsent(consentRecord(), {
        now: NOW,
        requiredScope: 'different-scope'
      })
    ).toMatchObject({ allowed: false, reason: 'scope_mismatch' });
    expect(
      evaluatePublicProspectConsent(
        consentRecord({
          consent: { ...consent, capturedAt: '2026-04-02T00:00:00.000Z' }
        }),
        NOW
      )
    ).toMatchObject({ allowed: false, reason: 'captured_in_future' });
    expect(() => assertPublicProspectConsentUsable(consentRecord(), NOW)).not.toThrow();
    expect(() =>
      assertPublicProspectConsentUsable(
        consentRecord({ consentStatus: 'expired' }),
        NOW
      )
    ).toThrow(ValidationError);
  });
});
