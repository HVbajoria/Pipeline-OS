import type { ActorContext } from '../shared/models';
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  type JsonSchema,
  type OperationAnnotations,
  type OperationDescriptor,
  type OperationInput,
  type OperationName,
  type OperationOutput
} from '../shared/operations';
import {
  actorContextForAgent,
  DEFAULT_AGENT_CONTEXT
} from '../client/actorContext';
import {
  operationClient,
  type OperationClient
} from '../client/operationClient';

export interface WebMcpNativeTool {
  name: OperationName;
  description: string;
  inputSchema: JsonSchema;
  execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  annotations: OperationAnnotations;
}

export interface WebMcpFallbackTool {
  name: OperationName;
  description: string;
  schema: JsonSchema;
  handler: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  annotations: OperationAnnotations;
}

export interface WebMcpRegisteredTool {
  name: OperationName;
  description: string;
  inputSchema: JsonSchema;
  /** Compatibility alias used by the development registry/documentation. */
  schema: JsonSchema;
  annotations: OperationAnnotations;
  /** Safe registry metadata used by permission-aware docs/hosts. */
  requiredCapability: string;
  approvalPolicy: OperationDescriptor['approvalPolicy'];
  execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
}

export interface WebMcpModelContext {
  registerTool: (tool: WebMcpNativeTool | WebMcpFallbackTool) => unknown;
}

declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }
  interface Navigator {
    modelContext?: WebMcpModelContext;
  }
  interface Window {
    __webmcp_tools?: Record<string, WebMcpRegisteredTool>;
  }
}

/** The exact descriptors made available to the documentation view and tests. */
export const registeredTools: WebMcpRegisteredTool[] = [];

export interface WebMcpRegistrationDiagnostic {
  toolName: OperationName;
  error: unknown;
}

const webMcpRegistrationDiagnostics: WebMcpRegistrationDiagnostic[] = [];

/** Rejections reported asynchronously by the native registration surface. */
export function getWebMcpRegistrationDiagnostics(): readonly WebMcpRegistrationDiagnostic[] {
  return webMcpRegistrationDiagnostics.map((diagnostic) => ({ ...diagnostic }));
}

function browserWindow(): Window | undefined {
  return typeof globalThis.window === 'object' ? globalThis.window : undefined;
}

function registerInDevelopmentRegistry(tool: WebMcpRegisteredTool): void {
  const target = browserWindow();
  if (!target) return;
  target.__webmcp_tools ??= {};
  target.__webmcp_tools[tool.name] = tool;
}

function observeNativeRegistration(
  toolName: OperationName,
  result: unknown
): void {
  // Promise.resolve also handles PromiseLike implementations while keeping
  // register() synchronous for existing adapters and tests. Every rejection
  // receives a handler, preventing an unhandled rejection from the browser's
  // native registration surface.
  void Promise.resolve(result).catch((error: unknown) => {
    webMcpRegistrationDiagnostics.push({ toolName, error });
  });
}

/**
 * Runtime isolation for WebMCP. Native registration is preferred, then the
 * repository's navigator polyfill shape, and finally the development window
 * registry used by docs and automated adapter tests.
 */
export class WebMcpRuntimeAdapter {
  register(tool: WebMcpRegisteredTool): 'native' | 'polyfill' | 'development' {
    const nativeContext =
      typeof globalThis.document === 'object'
        ? globalThis.document.modelContext
        : undefined;
    if (nativeContext?.registerTool) {
      const registrationResult = nativeContext.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: tool.execute,
        annotations: tool.annotations
      });
      observeNativeRegistration(tool.name, registrationResult);
      return 'native';
    }

    const navigatorContext =
      typeof globalThis.navigator === 'object'
        ? globalThis.navigator.modelContext
        : undefined;
    if (navigatorContext?.registerTool) {
      navigatorContext.registerTool({
        name: tool.name,
        description: tool.description,
        schema: tool.inputSchema,
        handler: tool.execute,
        annotations: tool.annotations
      });
      return 'polyfill';
    }

    registerInDevelopmentRegistry(tool);
    return 'development';
  }
}

export interface RegisterAllToolsOptions {
  client?: OperationClient;
  agentContext?: ActorContext;
  adapter?: WebMcpRuntimeAdapter;
  force?: boolean;
}

function normalizeOptions(
  options: RegisterAllToolsOptions | (() => void) | undefined
): RegisterAllToolsOptions {
  // The callback was accepted by the legacy adapter. It is intentionally
  // ignored now because OperationClient owns the post-invocation refresh.
  return typeof options === 'function' ? {} : options ?? {};
}

/** Register the shared registry exactly once with one shared client path. */
export function registerAllTools(
  optionsOrLegacyRefresh?: RegisterAllToolsOptions | (() => void)
): WebMcpRegisteredTool[] {
  const options = normalizeOptions(optionsOrLegacyRefresh);
  if (!options.force && registeredTools.length === OPERATION_NAMES.length) {
    return registeredTools;
  }

  registeredTools.length = 0;
  const client = options.client ?? operationClient;
  const agent = options.agentContext ?? actorContextForAgent(DEFAULT_AGENT_CONTEXT.actorId);
  const adapter = options.adapter ?? new WebMcpRuntimeAdapter();

  for (const name of OPERATION_NAMES) {
    const descriptor = OPERATION_REGISTRY[name];
    const execute = (
      input: unknown,
      signal?: AbortSignal
    ): Promise<OperationOutput<typeof name>> =>
      client.invoke(
        name,
        input as OperationInput<typeof name>,
        { actor: agent, signal }
      );
    const tool: WebMcpRegisteredTool = {
      name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      schema: descriptor.inputSchema,
      // Preserve the complete canonical annotation object for native,
      // navigator-polyfill, and development fallback registrations.
      annotations: { ...descriptor.annotations },
      requiredCapability: descriptor.requiredCapability,
      approvalPolicy: descriptor.approvalPolicy,
      execute
    };
    registeredTools.push(tool);
    adapter.register(tool);
  }

  return registeredTools;
}

export function resetWebMcpRegistry(): void {
  registeredTools.length = 0;
  webMcpRegistrationDiagnostics.length = 0;
  const target = browserWindow();
  if (target) delete target.__webmcp_tools;
}

export function getRegisteredTools(): readonly WebMcpRegisteredTool[] {
  return registeredTools;
}
