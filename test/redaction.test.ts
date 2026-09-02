import { describe, expect, it } from 'vitest';
import {
  redactActivityEntry,
  redactActivityPayload,
  redactJsonValue,
  redactJsonValueWithMetadata,
  redactTraceSpan
} from '../src/shared/domain/redaction';
import type { ActivityLogEntry } from '../src/shared/models';

const TIMESTAMP = '2026-04-01T12:00:00.000Z';

describe('shared activity and trace redaction', () => {
  it('recursively removes private values while preserving public attribution and status facts', () => {
    const value = {
      source: 'github',
      profileUrl: 'https://github.com/octocat',
      canonicalSourceUrl: 'https://api.github.com/users/octocat',
      publicRepos: 12,
      status: 'completed',
      nested: {
        email: 'candidate@example.com',
        resumeText: 'private resume',
        requestFingerprint: 'fingerprint-secret',
        safeCount: 2
      },
      list: [{ token: 'github-token', label: 'public result' }]
    };
    const original = structuredClone(value);
    const result = redactJsonValueWithMetadata(value);

    expect(result.value).toEqual({
      canonicalSourceUrl: 'https://api.github.com/users/octocat',
      list: [{ label: 'public result' }],
      nested: { safeCount: 2 },
      profileUrl: 'https://github.com/octocat',
      publicRepos: 12,
      source: 'github',
      status: 'completed'
    });
    expect(result.redactions).toEqual([
      '$.list[0].token',
      '$.nested.email',
      '$.nested.requestFingerprint',
      '$.nested.resumeText'
    ]);
    expect(value).toEqual(original);
    expect(JSON.stringify(result.value)).not.toContain('candidate@example.com');
    expect(JSON.stringify(result.value)).not.toContain('fingerprint-secret');
  });

  it('redacts activity payloads and trace summaries immutably with deterministic paths', () => {
    const entry: ActivityLogEntry = {
      id: 'activity-1',
      toolName: 'plan_operation',
      actorType: 'agent',
      actorId: 'agent-1',
      input: {
        targetOperation: 'import_public_prospect',
        normalizedInput: { resumeText: 'private' },
        idempotencyKey: 'retry-secret',
        profileUrl: 'https://github.com/octocat'
      },
      output: {
        status: 'pending',
        consentEvidence: 'private evidence',
        sourceUrl: 'https://github.com/octocat'
      },
      timestamp: TIMESTAMP,
      correlationId: 'correlation-1',
      traceId: 'trace-1',
      trace: {
        spans: [
          {
            spanId: 'span-1',
            name: 'plan',
            status: 'completed',
            startedAt: TIMESTAMP,
            summary: {
              safeCount: 1,
              targetFingerprint: 'private fingerprint',
              profileUrl: 'https://github.com/octocat'
            }
          }
        ]
      }
    };
    const original = structuredClone(entry);
    const payload = redactActivityPayload(entry);
    const redactedEntry = redactActivityEntry(entry);

    expect(payload.input).toEqual({
      profileUrl: 'https://github.com/octocat',
      targetOperation: 'import_public_prospect'
    });
    expect(payload.output).toEqual({
      sourceUrl: 'https://github.com/octocat',
      status: 'pending'
    });
    expect(payload.trace?.spans[0]?.summary).toEqual({
      profileUrl: 'https://github.com/octocat',
      safeCount: 1
    });
    expect(redactedEntry).toMatchObject({
      id: 'activity-1',
      correlationId: 'correlation-1',
      traceId: 'trace-1',
      input: payload.input,
      output: payload.output,
      trace: payload.trace
    });
    expect(redactedEntry.redactions).toEqual([
      '$.input.idempotencyKey',
      '$.input.normalizedInput',
      '$.output.consentEvidence',
      '$.trace.spans[0].summary.targetFingerprint'
    ]);
    expect(entry).toEqual(original);
  });

  it('preserves only safe trace lifecycle fields and drops non-JSON values', () => {
    const span = {
      spanId: 'span-1',
      name: 'search',
      status: 'completed' as const,
      startedAt: TIMESTAMP,
      durationMs: 8,
      summary: {
        profileUrl: 'https://github.com/octocat',
        email: 'hidden@example.com'
      }
    };
    expect(redactTraceSpan(span)).toEqual({
      spanId: 'span-1',
      name: 'search',
      status: 'completed',
      startedAt: TIMESTAMP,
      durationMs: 8,
      summary: { profileUrl: 'https://github.com/octocat' }
    });
    expect(redactJsonValue({ value: () => 'not JSON', nested: null })).toEqual({
      nested: null,
      value: null
    });
  });
});
