import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

import {
  buildMcpToolList,
  createMcpServer,
  descriptorToMcpTool,
  MCP_SERVER_INFO,
  type McpEndpointOptions
} from '../src/server/mcp';
import { MCP_TOOL_GUIDANCE } from '../src/server/mcpDescriptions';
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  type OperationName
} from '../src/shared/operations';
import { ForbiddenError } from '../src/shared/errors';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const DEMO_ACTOR = { actorType: 'human_ui' as const, actorId: 'sarah-recruiter' };

/**
 * A tiny stub dispatcher/identity so the adapter can be exercised without a
 * live repository or HTTP server. It records the last invocation so tests can
 * assert what the adapter forwarded.
 */
function stubOptions(
  overrides: Partial<McpEndpointOptions> & {
    invoke?: McpEndpointOptions['dispatcher']['invoke'];
  } = {}
): McpEndpointOptions & { calls: unknown[] } {
  const calls: unknown[] = [];
  const invoke =
    overrides.invoke ??
    (async (invocation: unknown) => {
      calls.push(invocation);
      return { ok: true };
    });
  return {
    calls,
    dispatcher: { invoke: invoke as McpEndpointOptions['dispatcher']['invoke'] },
    resolveIdentity: overrides.resolveIdentity ?? (async () => ({ actor: DEMO_ACTOR })),
    ...(overrides.environment === undefined ? {} : { environment: overrides.environment })
  };
}

const fakeRequest = {} as Request;

/** Invoke a request handler registered on the low-level MCP server. */
async function dispatch<T>(
  server: ReturnType<typeof createMcpServer>,
  schema: typeof ListToolsRequestSchema | typeof CallToolRequestSchema,
  params: Record<string, unknown>
): Promise<T> {
  // Access the internal handler map the SDK Server keeps for registered
  // request schemas. This mirrors what the transport does on a real request.
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<T>>;
  })._requestHandlers;
  const method = schema.shape.method.value as string;
  const handler = handlers.get(method);
  if (handler === undefined) throw new Error(`No handler for ${method}`);
  return handler({ method, params }, { signal: new AbortController().signal });
}

describe('MCP endpoint adapter', () => {
  it('advertises a stable server identity', () => {
    expect(MCP_SERVER_INFO.name).toBe('pipelineos');
    expect(typeof MCP_SERVER_INFO.version).toBe('string');
  });

  it('projects exactly the 32 canonical operations as tools', () => {
    const tools = buildMcpToolList();
    expect(tools).toHaveLength(OPERATION_NAMES.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...OPERATION_NAMES].sort()
    );
  });

  it('uses the canonical JSON Schemas for every tool', () => {
    for (const tool of buildMcpToolList()) {
      const descriptor = OPERATION_REGISTRY[tool.name as OperationName];
      expect(tool.inputSchema).toBe(descriptor.inputSchema);
      expect(tool.outputSchema).toBe(descriptor.outputSchema);
    }
  });

  it('gives every operation action-oriented, non-empty agent guidance', () => {
    for (const name of OPERATION_NAMES) {
      const guidance = MCP_TOOL_GUIDANCE[name];
      expect(guidance).toBeDefined();
      expect(guidance.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('marks read-only tools safe and idempotent, and direct mutations destructive', () => {
    const searchTool = descriptorToMcpTool(OPERATION_REGISTRY.search_candidates);
    expect(searchTool.annotations?.readOnlyHint).toBe(true);
    expect(searchTool.annotations?.idempotentHint).toBe(true);
    expect(searchTool.annotations?.destructiveHint).toBe(false);

    const sendOfferTool = descriptorToMcpTool(OPERATION_REGISTRY.send_offer);
    expect(sendOfferTool.annotations?.readOnlyHint).toBe(false);
    expect(sendOfferTool.annotations?.destructiveHint).toBe(true);
  });

  it('does not mark approval-staged coordinators as directly destructive and steers to the plan flow', () => {
    const coordinator = descriptorToMcpTool(
      OPERATION_REGISTRY.coordinate_interview_workflow
    );
    // It only stages an approval card on its own; commit applies the change.
    expect(coordinator.annotations?.destructiveHint).toBe(false);
    expect(coordinator.description).toMatch(/plan_operation/);
    expect(coordinator.description).toMatch(/approve_operation_plan/);
  });

  it('surfaces consent guidance for the public-prospect import', () => {
    const importTool = descriptorToMcpTool(OPERATION_REGISTRY.import_public_prospect);
    expect(importTool.description.toLowerCase()).toMatch(/consent/);
    expect(importTool.description).toMatch(/plan_operation/);
  });

  it('lists tools through the MCP tools/list handler', async () => {
    const server = createMcpServer(stubOptions(), fakeRequest);
    const result = await dispatch<{ tools: unknown[] }>(
      server,
      ListToolsRequestSchema,
      {}
    );
    expect(result.tools).toHaveLength(OPERATION_NAMES.length);
  });

  it('routes a read-only tools/call through the dispatcher without an idempotency key', async () => {
    const options = stubOptions();
    const server = createMcpServer(options, fakeRequest);
    const result = await dispatch<{ isError?: boolean }>(
      server,
      CallToolRequestSchema,
      { name: 'search_candidates', arguments: { query: 'backend' } }
    );
    expect(result.isError ?? false).toBe(false);
    expect(options.calls).toHaveLength(1);
    const invocation = options.calls[0] as {
      name: string;
      actor: unknown;
      metadata?: { idempotencyKey?: string };
    };
    expect(invocation.name).toBe('search_candidates');
    expect(invocation.actor).toEqual(DEMO_ACTOR);
    expect(invocation.metadata).toBeUndefined();
  });

  it('mints an idempotency key for a mutating tools/call', async () => {
    const options = stubOptions();
    const server = createMcpServer(options, fakeRequest);
    await dispatch(server, CallToolRequestSchema, {
      name: 'create_job_requisition',
      arguments: {
        title: 'X',
        department: 'Eng',
        requirements: ['a'],
        compBand: { min: 1, max: 2, currency: 'USD' }
      }
    });
    const invocation = options.calls[0] as {
      metadata?: { idempotencyKey?: string };
    };
    expect(invocation.metadata?.idempotencyKey).toMatch(/^mcp-/);
  });

  it('maps a PipelineError into a structured MCP error result', async () => {
    const options = stubOptions({
      invoke: async () => {
        throw new ForbiddenError('nope');
      }
    });
    const server = createMcpServer(options, fakeRequest);
    const result = await dispatch<{
      isError?: boolean;
      structuredContent?: { error?: { code?: string } };
    }>(server, CallToolRequestSchema, {
      name: 'create_job_requisition',
      arguments: {}
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe('FORBIDDEN_ERROR');
  });

  it('rejects an unknown tool name as a not-found error result', async () => {
    const server = createMcpServer(stubOptions(), fakeRequest);
    const result = await dispatch<{
      isError?: boolean;
      structuredContent?: { error?: { code?: string } };
    }>(server, CallToolRequestSchema, { name: 'not_a_real_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe('NOT_FOUND_ERROR');
  });
});
