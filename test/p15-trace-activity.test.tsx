import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActivityLogEntry, ActorContext } from '../src/shared/models';
import {
  MAX_TRACE_SPANS,
  MAX_TRACE_SUMMARY_PROPERTIES
} from '../src/shared/operations';
import { createOperationTrace } from '../src/server/trace';
import { OperationService } from '../src/server/operationService';
import { approvalOperationAdapters, defaultOperationHandlers } from '../src/server/operations';
import { serializeSharedState } from '../src/server/api';
import { createTestContext, TEST_TIMESTAMP } from './factories';
import { projectActivityEntry } from '../src/lib/viewModels';
import ActivityTracePanel from '../src/components/ActivityTracePanel';
import {
  SynchronizationController
} from '../src/client/synchronization';
import { actorContextForRole } from '../src/client/actorContext';
import { useStore } from '../src/lib/store';

const HUMAN: ActorContext = { actorType: 'human_ui', actorId: 'p15-human' };

function targetHandler(_input: { applicationId: string; action: string }, context: { preview: boolean }) {
  return {
    applicationId: 'app-1',
    stage: context.preview ? 'preview' : 'committed',
    proposedSlots: [],
    bookedInterview: null,
    nextAction: null,
    blockers: []
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('P15 trace construction and activity projection', () => {
  it('bounds root and child spans, summaries, names, and lifecycle duration', () => {
    let id = 0;
    const trace = createOperationTrace({
      operationName: 'x'.repeat(240),
      now: () => TEST_TIMESTAMP,
      identifiers: { next: (prefix) => `${prefix}-${++id}` }
    });
    const summary = Object.fromEntries(
      Array.from({ length: MAX_TRACE_SUMMARY_PROPERTIES + 5 }, (_, index) => [
        `property-${index}`,
        `value-${index}`
      ])
    );

    const firstChild = trace.startChild('y'.repeat(240), summary);
    trace.completeSpan(firstChild, 'completed');
    for (let index = 0; index < MAX_TRACE_SPANS + 10; index += 1) {
      const span = trace.startChild(`child-${index}`);
      trace.completeSpan(span, 'completed');
    }
    trace.finish();

    const snapshot = trace.snapshot();
    expect(snapshot.spans.length).toBeLessThanOrEqual(MAX_TRACE_SPANS);
    expect(snapshot.spans[0]?.name).toHaveLength(160);
    expect(snapshot.spans[1]?.name).toHaveLength(160);
    expect(Object.keys(snapshot.spans[1]?.summary ?? {})).toHaveLength(
      MAX_TRACE_SUMMARY_PROPERTIES
    );
    expect(snapshot.spans.every((span) => span.status !== 'started')).toBe(true);
    expect(snapshot.spans.every((span) => span.durationMs !== undefined && span.durationMs >= 0)).toBe(true);
    expect(snapshot.spans.slice(1).every((span) => span.parentSpanId === snapshot.spans[0]?.spanId)).toBe(true);
  });

  it('persists traces for canonical envelopes while preserving the legacy activity shape', async () => {
    const context = createTestContext();
    const service = new OperationService({
      repository: context.repository,
      handlers: defaultOperationHandlers
    });

    await service.invoke({
      name: 'search_candidates',
      input: { query: 'backend' },
      actor: HUMAN
    });
    const canonicalEntry = context.repository.read().activityLog.at(-1);
    expect(canonicalEntry?.trace).toBeDefined();
    expect(canonicalEntry?.correlationId).toBeDefined();
    expect(canonicalEntry?.traceId).toBeDefined();

    await service.invoke('search_candidates', { query: 'backend' }, HUMAN);
    const legacyEntry = context.repository.read().activityLog.at(-1);
    expect(Object.keys(legacyEntry ?? {}).sort()).toEqual([
      'actorId',
      'actorType',
      'id',
      'input',
      'output',
      'timestamp',
      'toolName'
    ]);
  });

  it('continues correlation, trace, and parent links across approval lifecycle entries', async () => {
    const context = createTestContext();
    const service = new OperationService({
      repository: context.repository,
      handlers: { coordinate_interview_workflow: targetHandler },
      orchestrationAdapters: approvalOperationAdapters
    });

    const plan = await service.invoke({
      name: 'plan_operation',
      input: {
        targetOperation: 'coordinate_interview_workflow',
        input: { applicationId: 'app-1', action: 'propose_slots' }
      },
      actor: HUMAN,
      metadata: { idempotencyKey: 'p15-plan' }
    });
    await service.invoke({
      name: 'approve_operation_plan',
      input: { approvalId: plan.approvalId },
      actor: HUMAN,
      metadata: { idempotencyKey: 'p15-approval' }
    });
    await service.invoke({
      name: 'commit_operation_plan',
      input: { approvalId: plan.approvalId },
      actor: HUMAN,
      metadata: { idempotencyKey: 'p15-commit' }
    });

    const related = context.repository.read().activityLog.filter(
      (entry) => entry.approvalId === plan.approvalId
    );
    expect(related.map((entry) => entry.toolName)).toEqual([
      'plan_operation',
      'approve_operation_plan',
      'commit_operation_plan'
    ]);
    expect(new Set(related.map((entry) => entry.correlationId))).toHaveLength(1);
    expect(new Set(related.map((entry) => entry.traceId))).toHaveLength(1);
    expect(related[1]?.parentSpanId).toBe(related[0]?.spanId);
    expect(related[2]?.parentSpanId).toBe(related[1]?.spanId);
  });

  it('redacts legacy sensitive activity values at the state boundary and renders safe trace spans', () => {
    const context = createTestContext();
    const entry: ActivityLogEntry = {
      id: 'activity-p15-private',
      toolName: 'legacy_operation',
      actorType: HUMAN.actorType,
      actorId: HUMAN.actorId,
      input: { email: 'private@example.test', safe: 'visible' },
      output: { resumeText: 'private resume', result: 'ok' },
      timestamp: TEST_TIMESTAMP,
      traceId: 'trace-p15-private',
      trace: {
        spans: [
          {
            spanId: 'span-p15-root',
            name: 'legacy_operation',
            status: 'completed',
            startedAt: TEST_TIMESTAMP,
            durationMs: 4,
            summary: { email: 'private@example.test', profileUrl: 'https://example.test/profile' }
          }
        ]
      }
    };
    context.repository.appendActivity(entry);

    const projected = serializeSharedState(context.repository.read()).activityLog.at(-1);
    expect(projected).toBeDefined();
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('private resume');
    expect(projected?.trace?.spans[0]?.summary).toEqual({
      profileUrl: 'https://example.test/profile'
    });
    expect(projected?.redactions).toEqual(
      expect.arrayContaining(['$.input.email', '$.output.resumeText', '$.trace.spans[0].summary.email'])
    );

    const feedItem = projectActivityEntry(projected!);
    const markup = renderToStaticMarkup(
      createElement(ActivityTracePanel, { entry: feedItem })
    );
    expect(markup).toContain('data-activity-trace');
    expect(markup).toContain('Show trace');
    expect(markup).toContain('trace-p15-private');
    expect(markup).not.toContain('private@example.test');
  });

  it('reconnects the revision-only synchronization stream after an actor switch', async () => {
    const before = useStore.getState().snapshot();
    const previousRole = useStore.getState().currentRole;
    const requests: Array<{ actorId: string; url: string }> = [];
    const closed: string[] = [];
    const projection = {
      ...before,
      revision: before.revision + 1,
      activityLog: []
    };
    const controller = new SynchronizationController({
      actorContext: () => actorContextForRole(useStore.getState().currentRole),
      fetcher: async (_input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ actorId: headers.get('x-actor-id') ?? '', url: String(_input) });
        return response(projection);
      },
      eventSourceFactory: (url) => ({
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => closed.push(url)
      })
    });

    const initialActorId = actorContextForRole(previousRole).actorId;
    try {
      await controller.start();
      useStore.setState({ currentRole: 'candidate' });
      await controller.refreshForActorChange();
      expect(requests.map((request) => request.actorId)).toEqual([
        initialActorId,
        'alice-candidate'
      ]);
      expect(closed).toHaveLength(1);
      expect(new URL(closed[0]!, 'http://localhost').pathname).toBe('/api/events');
    } finally {
      controller.stop();
      useStore.getState().hydrate(before);
      useStore.setState({ currentRole: previousRole });
    }
  });
});
