import { describe, expect, it } from 'vitest';
import type { ActivityLogEntry } from '../src/shared/models';
import { MetricsRegistry } from '../src/server/observability/metrics';

function activity(overrides: Partial<ActivityLogEntry>): ActivityLogEntry {
  return {
    id: 'act-1',
    toolName: 'search_candidates',
    actorType: 'agent',
    actorId: 'agent-demo',
    input: {},
    output: {},
    timestamp: '2026-09-03T00:00:00.000Z',
    ...overrides
  } as ActivityLogEntry;
}

function withDuration(ms: number): ActivityLogEntry['trace'] {
  return {
    spans: [
      {
        spanId: 'span-root',
        name: 'op',
        status: 'completed',
        startedAt: '2026-09-03T00:00:00.000Z',
        completedAt: '2026-09-03T00:00:00.050Z',
        durationMs: ms
      }
    ]
  };
}

describe('metrics registry', () => {
  it('counts operations, errors, and latency from activity entries', () => {
    const registry = new MetricsRegistry();

    registry.recordActivity(
      activity({ toolName: 'screen_candidate', phase: 'commit', trace: withDuration(12) })
    );
    registry.recordActivity(
      activity({
        toolName: 'send_offer',
        phase: 'commit',
        actorType: 'agent',
        output: { error: { code: 'FORBIDDEN_ERROR', status: 403, message: 'no' } },
        trace: withDuration(3)
      })
    );

    const text = registry.render();

    // Operation counter split by outcome.
    expect(text).toContain('pipelineos_operations_total');
    expect(text).toMatch(/operation="screen_candidate".*outcome="success".* 1/);
    expect(text).toMatch(/operation="send_offer".*outcome="error".* 1/);

    // Error counter keyed by structured code.
    expect(text).toMatch(
      /pipelineos_operation_errors_total\{code="FORBIDDEN_ERROR",operation="send_offer"\} 1/
    );

    // Latency histogram present with buckets and a count.
    expect(text).toContain('pipelineos_operation_duration_seconds_bucket');
    expect(text).toContain('pipelineos_operation_duration_seconds_count');
  });

  it('counts MCP tool calls and exposes the Prometheus content type', () => {
    const registry = new MetricsRegistry();
    registry.recordMcpToolCall('search_candidates', 'success');
    registry.recordMcpToolCall('search_candidates', 'success');
    registry.recordMcpToolCall('send_offer', 'error');

    const text = registry.render();
    expect(text).toMatch(
      /pipelineos_mcp_tool_calls_total\{outcome="success",tool="search_candidates"\} 2/
    );
    expect(text).toMatch(
      /pipelineos_mcp_tool_calls_total\{outcome="error",tool="send_offer"\} 1/
    );
    expect(registry.contentType).toContain('text/plain');
  });

  it('consumes only newly appended activity entries without double counting', () => {
    const registry = new MetricsRegistry();
    const log: ActivityLogEntry[] = [
      activity({ toolName: 'a', trace: withDuration(1) }),
      activity({ toolName: 'b', trace: withDuration(1) })
    ];
    registry.consumeNewActivity(log);
    log.push(activity({ toolName: 'c', trace: withDuration(1) }));
    registry.consumeNewActivity(log);

    const text = registry.render();
    // Three distinct operations each counted exactly once.
    expect(text).toMatch(/operation="a".* 1/);
    expect(text).toMatch(/operation="b".* 1/);
    expect(text).toMatch(/operation="c".* 1/);
  });
});
