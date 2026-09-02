import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/shared/errors';
import {
  buildRequestFingerprintInput,
  canonicalJsonString,
  normalizeInvocationMetadata,
  requestFingerprintCanonicalString
} from '../src/shared/domain/invocationMetadata';

const ACTOR = { actorType: 'human_ui' as const, actorId: 'recruiter-1' };

describe('pure invocation metadata and fingerprint material', () => {
  it('normalizes metadata without generating or injecting transport values', () => {
    expect(
      normalizeInvocationMetadata({
        correlationId: '  correlation-1 ',
        idempotencyKey: ' retry-1 ',
        expectedRevision: 4,
        approvalId: ' approval-1 ',
        parentSpanId: ' span-1 '
      })
    ).toEqual({
      correlationId: 'correlation-1',
      idempotencyKey: 'retry-1',
      expectedRevision: 4,
      approvalId: 'approval-1',
      parentSpanId: 'span-1'
    });
    expect(normalizeInvocationMetadata(undefined)).toBeUndefined();

    for (const invalid of [
      { unsupported: true },
      { correlationId: 'bad\nvalue' },
      { idempotencyKey: '' },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      null
    ]) {
      expect(() => normalizeInvocationMetadata(invalid)).toThrow(ValidationError);
    }
  });

  it('canonicalizes JSON objects and keeps arrays semantically ordered', () => {
    expect(canonicalJsonString({ z: 1, nested: { b: 2, a: 1 }, a: [2, 1] })).toBe(
      '{"a":[2,1],"nested":{"a":1,"b":2},"z":1}'
    );
    expect(canonicalJsonString({ value: -0 })).toBe('{"value":0}');
    expect(() => canonicalJsonString({ value: Number.NaN })).toThrow(ValidationError);
    expect(() => canonicalJsonString({ value: undefined })).toThrow(ValidationError);
  });

  it('builds safe fingerprint material independent of correlation, retry key, and parent span', () => {
    const first = buildRequestFingerprintInput({
      operationName: 'book_interview',
      input: { slot: '2026-04-02T12:00:00.000Z', applicationId: 'app-1' },
      actor: ACTOR,
      metadata: {
        correlationId: 'correlation-a',
        idempotencyKey: 'retry-secret-a',
        parentSpanId: 'span-a',
        approvalId: 'approval-1',
        expectedRevision: 7
      }
    });
    const second = buildRequestFingerprintInput(
      'book_interview',
      { applicationId: 'app-1', slot: '2026-04-02T12:00:00.000Z' },
      ACTOR,
      {
        correlationId: 'correlation-b',
        idempotencyKey: 'retry-secret-b',
        parentSpanId: 'span-b',
        approvalId: 'approval-1',
        expectedRevision: 7
      }
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      operationName: 'book_interview',
      input: { applicationId: 'app-1', slot: '2026-04-02T12:00:00.000Z' },
      actorScope: ACTOR,
      approvalId: 'approval-1',
      expectedRevision: 7
    });
    expect(JSON.stringify(first)).not.toContain('retry-secret');
    expect(JSON.stringify(first)).not.toContain('correlation');
    expect(JSON.stringify(first)).not.toContain('span-a');
    expect(
      requestFingerprintCanonicalString({
        operationName: 'book_interview',
        input: { applicationId: 'app-1', slot: '2026-04-02T12:00:00.000Z' },
        actor: ACTOR,
        metadata: {
          correlationId: 'different-correlation',
          idempotencyKey: 'different-retry-key',
          parentSpanId: 'different-parent',
          approvalId: 'approval-1',
          expectedRevision: 7
        }
      })
    ).toBe(canonicalJsonString(first, 'requestFingerprint'));
  });

  it('changes fingerprint material when trusted scope or commit metadata changes', () => {
    const base = buildRequestFingerprintInput('create_job_requisition', { title: 'Role' }, ACTOR);
    expect(
      buildRequestFingerprintInput(
        'create_job_requisition',
        { title: 'Role' },
        { actorType: 'agent', actorId: 'agent-1' }
      )
    ).not.toEqual(base);
    expect(
      buildRequestFingerprintInput('create_job_requisition', { title: 'Role' }, ACTOR, {
        expectedRevision: 2
      })
    ).not.toEqual(base);
  });
});
