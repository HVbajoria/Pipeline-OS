/**
 * Remote MCP endpoint for PipelineOS.
 *
 * This module is a thin transport adapter. It exposes the exact same 32
 * canonical operations that back the UI and the in-browser WebMCP surface,
 * but over the Model Context Protocol's Streamable HTTP transport so that a
 * remote agent host (for example ChatGPT's connector feature, Claude, or any
 * MCP client) can list and call them.
 *
 * There is deliberately NO business logic here:
 *   - `tools/list` is projected directly from `OPERATION_REGISTRY`.
 *   - `tools/call` resolves the trusted principal with the same request
 *     identity path used by the HTTP API, then dispatches through the shared
 *     `OperationService.invoke`. Authorization, validation, lifecycle guards,
 *     idempotency, the audit trail, and the structured `PipelineError`
 *     envelope are all owned by the service, exactly as for a UI click.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';

import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  isOperationName,
  type JsonSchema,
  type OperationDescriptor,
  type OperationName
} from '../shared/operations';
import { PipelineError } from '../shared/errors';
import type { OperationInvocationContext } from './operationService';
import type { RequestIdentity } from './api';
import {
  MCP_CONFIRMATION_GUIDANCE,
  MCP_TOOL_GUIDANCE,
  type McpConfirmationMode
} from './mcpDescriptions';
import { APP_NAME, APP_VERSION } from './version';

/**
 * Server identity advertised to MCP clients during `initialize`. Sourced from
 * package.json (via version.ts) so it never drifts from the release version.
 */
export const MCP_SERVER_INFO = {
  name: APP_NAME,
  version: APP_VERSION
} as const;

/**
 * The service surface the MCP adapter needs. Kept intentionally narrow so the
 * adapter never reaches past the shared operation boundary.
 */
export interface McpOperationDispatcher {
  invoke(
    invocation: {
      name: OperationName;
      input: unknown;
      actor: RequestIdentity['actor'];
      metadata?: Record<string, unknown>;
    },
    context?: OperationInvocationContext
  ): Promise<unknown>;
}

export interface McpEndpointOptions {
  /** Shared operation service; the same instance used by the HTTP routes. */
  dispatcher: McpOperationDispatcher;
  /**
   * Resolve the trusted principal/actor for a request. This is the same
   * function the HTTP API uses, so MCP calls honor the identical trust and
   * authorization boundary (production ignores arbitrary actor headers).
   */
  resolveIdentity: (request: Request) => Promise<RequestIdentity>;
  /** Environment forwarded to the operation invocation context. */
  environment?: OperationInvocationContext['environment'];
  /**
   * Optional observability hook fired once per `tools/call`, after the call
   * settles, with the tool name and outcome. Used to count MCP tool-call
   * volume without coupling the transport to a metrics implementation.
   */
  onToolCall?: (tool: string, outcome: 'success' | 'error') => void;
}

/** Resolve the confirmation mode for a descriptor from its approval policy. */
function confirmationMode(descriptor: OperationDescriptor): McpConfirmationMode {
  const guidance = MCP_TOOL_GUIDANCE[descriptor.name];
  if (guidance !== undefined) return guidance.confirmation;
  // Defensive default derived from the canonical policy, in case a new
  // operation is added before its guidance entry exists.
  if (descriptor.readOnly) return 'none';
  if (descriptor.approvalPolicy === 'consent_and_human') return 'consent_and_plan';
  if (descriptor.approvalPolicy === 'human') return 'plan';
  return 'confirm';
}

/**
 * Build the agent-facing tool description shown to an MCP host such as
 * ChatGPT. It layers action-oriented guidance (who calls it, when, what it
 * returns, how it sequences) on top of an explicit human-in-the-loop
 * expectation, so the model chooses and confirms tools safely. The canonical
 * registry description is preserved elsewhere (docs, WebMCP); this text is the
 * MCP presentation only.
 */
function toolDescription(descriptor: OperationDescriptor): string {
  const guidance = MCP_TOOL_GUIDANCE[descriptor.name];
  const parts: string[] = [
    (guidance?.summary ?? descriptor.description).trim()
  ];

  const confirmationText = MCP_CONFIRMATION_GUIDANCE[confirmationMode(descriptor)];
  if (confirmationText.length > 0) parts.push(confirmationText);

  return parts.join(' ');
}

/** Project one registry descriptor into an MCP `Tool` for `tools/list`. */
export function descriptorToMcpTool(descriptor: OperationDescriptor): Tool {
  const mode = confirmationMode(descriptor);
  // A read-only tool is safe and idempotent. A mutation that must go through
  // the plan/approve/commit workflow is not "destructive" on its own call
  // (it only stages a card); a direct mutation that changes records is marked
  // destructive so hosts prompt before running it. `openWorldHint` is false
  // because every operation acts on this system's own bounded state.
  const readOnly = descriptor.readOnly;
  const stagedThroughApproval = mode === 'plan' || mode === 'consent_and_plan';
  return {
    name: descriptor.name,
    description: toolDescription(descriptor),
    // The registry input schema is already plain, JSON-serializable JSON
    // Schema, which is exactly what the MCP `inputSchema` field expects.
    inputSchema: descriptor.inputSchema as JsonSchema as Tool['inputSchema'],
    outputSchema: descriptor.outputSchema as JsonSchema as Tool['outputSchema'],
    annotations: {
      title: descriptor.name,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly && !stagedThroughApproval,
      idempotentHint: readOnly,
      openWorldHint: false
    }
  };
}

/** The full list of MCP tools, one per canonical operation. */
export function buildMcpToolList(): Tool[] {
  return OPERATION_NAMES.map((name) => descriptorToMcpTool(OPERATION_REGISTRY[name]));
}

/**
 * Render an operation output (or a caught error) as an MCP `CallToolResult`.
 * A `PipelineError` is surfaced as an error result carrying the same
 * structured envelope the HTTP and UI boundaries return, so the model can see
 * the code, message, and safe details rather than an opaque failure.
 */
function successResult(output: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(output, null, 2)
      }
    ],
    structuredContent:
      output !== null && typeof output === 'object' && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : { result: output }
  };
}

function errorResult(error: unknown): CallToolResult {
  const pipelineError = PipelineError.from(error);
  const payload = pipelineError.toPayload();
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload as unknown as Record<string, unknown>
  };
}

/**
 * Build a fresh low-level MCP `Server` with `tools/list` and `tools/call`
 * wired to the shared dispatcher. A new server + transport pair is created per
 * request for stateless Streamable HTTP, which is the model that remote
 * connectors (including ChatGPT) use.
 */
export function createMcpServer(
  options: McpEndpointOptions,
  request: Request
): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} }
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: buildMcpToolList()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (callRequest) => {
    const { name, arguments: rawArgs } = callRequest.params;

    if (!isOperationName(name)) {
      options.onToolCall?.(String(name), 'error');
      return errorResult(
        new PipelineError({
          code: 'NOT_FOUND_ERROR',
          message: `Unknown tool: ${String(name)}`
        })
      );
    }

    try {
      const identity = await options.resolveIdentity(request);
      const context: OperationInvocationContext | undefined =
        identity.principal === undefined && options.environment === undefined
          ? undefined
          : {
              ...(identity.principal === undefined
                ? {}
                : { principal: identity.principal }),
              ...(options.environment === undefined
                ? {}
                : { environment: options.environment })
            };

      // Mutations/plans/approvals require an idempotency key at the envelope
      // boundary. A remote agent may not supply one, so mint a stable-per-call
      // key here; retries from the client still arrive as distinct calls.
      const descriptor = OPERATION_REGISTRY[name];
      const metadata =
        descriptor.readOnly
          ? undefined
          : { idempotencyKey: `mcp-${randomUUID()}` };

      const output = await options.dispatcher.invoke(
        {
          name,
          input: rawArgs ?? {},
          actor: identity.actor,
          ...(metadata === undefined ? {} : { metadata })
        },
        context
      );
      options.onToolCall?.(name, 'success');
      return successResult(output);
    } catch (error) {
      // Surface domain/authorization failures as structured tool errors rather
      // than transport-level exceptions, so the model can reason about them.
      options.onToolCall?.(name, 'error');
      return errorResult(error);
    }
  });

  return server;
}

/**
 * Express handler for the `/mcp` endpoint. Uses the Streamable HTTP transport
 * in stateless mode (no server-managed session id), which is the simplest and
 * most compatible shape for remote connectors: each JSON-RPC request is
 * self-contained and identity is resolved per request.
 */
export function createMcpRequestHandler(options: McpEndpointOptions) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const server = createMcpServer(options, request);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      response.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      next(error);
    }
  };
}
