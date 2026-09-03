/**
 * Lightweight, dependency-free metrics for PipelineOS, exported in Prometheus
 * text exposition format at `/metrics`.
 *
 * Rather than pull in the full OpenTelemetry SDK (heavy, and the server is
 * bundled with external deps), this module derives operational metrics from
 * the data the system already produces: every operation — success, failure, or
 * replay — appends exactly one activity entry that carries the operation name,
 * actor, phase, correlation/trace ids, the structured error payload on
 * failure, and a trace whose root span has a `durationMs`. `recordActivity`
 * turns each entry into counters and a latency histogram, and MCP tool calls
 * are counted separately at the transport. The exposition text is
 * Prometheus/OpenMetrics-compatible, so any scraper or an OTel collector's
 * Prometheus receiver can consume it.
 */

import type { ActivityLogEntry, JsonObject } from '../../shared/models';

/** Histogram buckets (seconds) tuned for in-memory/DB operation latencies. */
const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
];

type LabelSet = Record<string, string>;

function labelKey(labels: LabelSet): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: LabelSet): string {
  const entries = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`);
  return entries.length === 0 ? '' : `{${entries.join(',')}}`;
}

class Counter {
  private readonly values = new Map<string, { labels: LabelSet; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  inc(labels: LabelSet = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing === undefined) this.values.set(key, { labels, value: amount });
    else existing.value += amount;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const { labels, value } of this.values.values()) {
        lines.push(`${this.name}${renderLabels(labels)} ${value}`);
      }
    }
    return lines.join('\n');
  }
}

class Histogram {
  private readonly buckets: number[];
  private readonly series = new Map<
    string,
    { labels: LabelSet; counts: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = LATENCY_BUCKETS_SECONDS
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(valueSeconds: number, labels: LabelSet = {}): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.count += 1;
    entry.sum += valueSeconds;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (valueSeconds <= this.buckets[i]!) entry.counts[i]! += 1;
    }
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        cumulative += entry.counts[i]!;
        const bucketLabels = { ...entry.labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${renderLabels(bucketLabels)} ${cumulative}`);
      }
      lines.push(
        `${this.name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`
      );
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

function errorCodeFromOutput(output: JsonObject | undefined): string | undefined {
  const error = output?.error;
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as JsonObject).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function rootDurationSeconds(entry: ActivityLogEntry): number | undefined {
  const spans = entry.trace?.spans;
  if (!Array.isArray(spans) || spans.length === 0) return undefined;
  // The root span is authored first and carries the whole-operation duration.
  const root = spans[0];
  const durationMs = root?.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? durationMs / 1000
    : undefined;
}

/** The metrics registry. One instance per server; safe to share. */
export class MetricsRegistry {
  private readonly startTime = Date.now();
  private readonly operations = new Counter(
    'pipelineos_operations_total',
    'Total operation invocations by operation, phase, actor type, and outcome.'
  );
  private readonly errors = new Counter(
    'pipelineos_operation_errors_total',
    'Total failed operations by operation and structured error code.'
  );
  private readonly mcpCalls = new Counter(
    'pipelineos_mcp_tool_calls_total',
    'Total MCP tools/call invocations by tool and outcome.'
  );
  private readonly latency = new Histogram(
    'pipelineos_operation_duration_seconds',
    'Operation execution wall-clock duration in seconds, from the root trace span.'
  );
  /** Track the highest activity-log index consumed to avoid double counting. */
  private lastConsumedLength = 0;

  /** Record one activity-log entry. Idempotent per entry is the caller's job. */
  recordActivity(entry: ActivityLogEntry): void {
    const operation = entry.toolName ?? 'unknown';
    const phase = entry.phase ?? 'unknown';
    const actorType = entry.actorType ?? 'unknown';
    const errorCode = errorCodeFromOutput(entry.output);
    const outcome = errorCode === undefined ? 'success' : 'error';

    this.operations.inc({ operation, phase, actor_type: actorType, outcome });
    if (errorCode !== undefined) {
      this.errors.inc({ operation, code: errorCode });
    }
    const durationSeconds = rootDurationSeconds(entry);
    if (durationSeconds !== undefined) {
      this.latency.observe(durationSeconds, { operation, outcome });
    }
  }

  /**
   * Consume any activity entries appended since the last call. Used by the
   * repository subscription so metrics stay current without the operation path
   * knowing metrics exist.
   */
  consumeNewActivity(activityLog: readonly ActivityLogEntry[]): void {
    if (activityLog.length <= this.lastConsumedLength) {
      // A reset shrinks the log; realign without replaying historical entries.
      this.lastConsumedLength = activityLog.length;
      return;
    }
    for (let i = this.lastConsumedLength; i < activityLog.length; i += 1) {
      this.recordActivity(activityLog[i]!);
    }
    this.lastConsumedLength = activityLog.length;
  }

  /** Count one MCP tools/call at the transport boundary. */
  recordMcpToolCall(tool: string, outcome: 'success' | 'error'): void {
    this.mcpCalls.inc({ tool, outcome });
  }

  /** Render the full registry in Prometheus text exposition format. */
  render(): string {
    const uptimeSeconds = (Date.now() - this.startTime) / 1000;
    const mem = process.memoryUsage();
    const processBlock = [
      '# HELP pipelineos_process_uptime_seconds Process uptime in seconds.',
      '# TYPE pipelineos_process_uptime_seconds gauge',
      `pipelineos_process_uptime_seconds ${uptimeSeconds}`,
      '# HELP pipelineos_process_resident_memory_bytes Resident set size in bytes.',
      '# TYPE pipelineos_process_resident_memory_bytes gauge',
      `pipelineos_process_resident_memory_bytes ${mem.rss}`,
      '# HELP pipelineos_process_heap_used_bytes Heap used in bytes.',
      '# TYPE pipelineos_process_heap_used_bytes gauge',
      `pipelineos_process_heap_used_bytes ${mem.heapUsed}`
    ].join('\n');

    return [
      this.operations.render(),
      this.errors.render(),
      this.mcpCalls.render(),
      this.latency.render(),
      processBlock,
      ''
    ].join('\n\n');
  }

  /** Prometheus exposition content type for the /metrics response. */
  get contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }

  /** Reset all series (tests). */
  reset(): void {
    this.operations.reset();
    this.errors.reset();
    this.mcpCalls.reset();
    this.latency.reset();
    this.lastConsumedLength = 0;
  }
}

/**
 * Subscribe a metrics registry to a repository so every committed activity
 * entry is counted. Returns the unsubscribe function. The repository publishes
 * full snapshots on commit, so we diff by activity-log length.
 */
export function subscribeMetricsToRepository(
  registry: MetricsRegistry,
  repository: {
    read(): { activityLog: readonly ActivityLogEntry[] };
    subscribe(listener: (snapshot: { activityLog: readonly ActivityLogEntry[] }) => void): () => void;
  }
): () => void {
  // Seed the baseline so we do not replay pre-existing seed activity.
  registry.consumeNewActivity(repository.read().activityLog);
  return repository.subscribe((snapshot) => {
    registry.consumeNewActivity(snapshot.activityLog);
  });
}

let sharedRegistry: MetricsRegistry | undefined;

/** A process-wide shared registry, created on first use. */
export function getMetricsRegistry(): MetricsRegistry {
  if (sharedRegistry === undefined) sharedRegistry = new MetricsRegistry();
  return sharedRegistry;
}
