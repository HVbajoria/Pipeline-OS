import { useState } from 'react';
import type { ActivityFeedItem } from '../lib/viewModels';
import type { TraceSpan } from '../shared/models';

const MAX_RENDERED_SPANS = 50;

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function spanDepth(span: TraceSpan, spansById: Map<string, TraceSpan>): number {
  let depth = 0;
  const visited = new Set<string>();
  let parentId = span.parentSpanId;
  while (parentId !== undefined && !visited.has(parentId) && depth < 10) {
    visited.add(parentId);
    const parent = spansById.get(parentId);
    if (parent === undefined) break;
    depth += 1;
    parentId = parent.parentSpanId;
  }
  return depth;
}

export interface ActivityTracePanelProps {
  entry: ActivityFeedItem;
}

/** Render only the server-projected trace lifecycle and safe summaries. */
export function ActivityTracePanel({ entry }: ActivityTracePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const trace = entry.trace;
  const spans = trace?.spans.slice(0, MAX_RENDERED_SPANS) ?? [];
  if (spans.length === 0) return null;
  const spansById = new Map(spans.map((span) => [span.spanId, span] as const));

  return (
    <div
      className="activity-trace-panel"
      data-activity-trace
      data-trace-id={entry.traceId}
    >
      <button
        type="button"
        className="trace-toggle ui-button ui-button--ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-trace-toggle
      >
        {expanded ? 'Hide' : 'Show'} trace{entry.traceId ? ` ${entry.traceId}` : ''} ({spans.length} span{spans.length === 1 ? '' : 's'})
      </button>
      {expanded && (
        <div className="mt-2 space-y-1" data-trace-timeline>
          {spans.map((span) => (
            <div
              key={span.spanId}
              data-trace-span={span.spanId}
              data-trace-span-status={span.status}
              className="rounded border border-slate-100 bg-slate-50 p-2 text-xs"
              style={{ marginLeft: `${Math.min(spanDepth(span, spansById), 4) * 8}px` }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-800 break-all">{span.name}</span>
                <span className="rounded bg-white px-1.5 py-0.5 text-slate-600">{span.status}</span>
              </div>
              <div className="mt-1 text-slate-500">
                <span>span: {span.spanId}</span>
                {span.parentSpanId && <span> · parent: {span.parentSpanId}</span>}
                {span.durationMs !== undefined && <span> · {span.durationMs}ms</span>}
              </div>
              {span.summary && (
                <pre className="mt-1 overflow-x-auto rounded bg-white p-1 font-mono text-[10px] text-slate-600">
                  {json(span.summary)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ActivityTracePanel;
