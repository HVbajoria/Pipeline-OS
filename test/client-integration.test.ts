import { describe, expect, it } from 'vitest';
import { actorContextForAgent, actorContextForRole } from '../src/client/actorContext';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { SynchronizationController } from '../src/client/synchronization';
import { useStore } from '../src/lib/store';
import { projectActivityFeed, projectKanban } from '../src/lib/viewModels';
import {
  getWebMcpRegistrationDiagnostics,
  registerAllTools,
  resetWebMcpRegistry,
  WebMcpRuntimeAdapter
} from '../src/lib/webmcp';
import { PipelineError } from '../src/shared/errors';
import type { SharedStateProjectionWithCatalogs } from '../src/shared/models';
import { OPERATION_NAMES, OPERATION_REGISTRY } from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  close(): void { this.closed = true; }

  emit(revision: number): void {
    const event = { data: JSON.stringify({ type: 'state_changed', revision }) } as MessageEvent<string>;
    this.listeners.get('state_changed')?.(event);
    this.onmessage?.(event);
  }
}

function serviceFetch(service: OperationService): FetchLike {
  return async (request, init) => {
    const url = String(request);
    if (url.endsWith('/api/state')) return jsonResponse(serializeSharedState(service.repository.read()));
    const operationName = url.split('/').at(-1) as keyof typeof OPERATION_REGISTRY;
    const input = JSON.parse(String(init?.body ?? '{}')) as { input: unknown };
    const headers = new Headers(init?.headers);
    const actor = {
      actorType: headers.get('x-actor-type') as 'human_ui' | 'agent',
      actorId: headers.get('x-actor-id') ?? 'unknown'
    };
    try {
      const output = await service.invoke(operationName, input.input as never, actor);
      return jsonResponse(output);
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return jsonResponse(pipelineError.toPayload(), pipelineError.status);
    }
  };
}

function domainCollections(projection: SharedStateProjectionWithCatalogs) {
  return {
    jobs: projection.jobs,
    candidates: projection.candidates,
    applications: projection.applications,
    panels: projection.panels,
    interviews: projection.interviews,
    scorecards: projection.scorecards,
    offers: projection.offers,
    onboardingTasks: projection.onboardingTasks,
    backgroundChecks: projection.backgroundChecks,
    benefitsEnrollments: projection.benefitsEnrollments
  };
}

describe('typed client, WebMCP, store, and synchronization integration', () => {
  it('projects a UI mutation and a WebMCP mutation into one persisted snapshot', async () => {
    const service = new OperationService(new SharedStateRepository(createSeed()), defaultOperationHandlers);
    const fetcher = serviceFetch(service);
    const client = new OperationClient({
      fetcher,
      refreshState: async () => {
        const response = await fetcher('/api/state');
        const projection = await response.json() as SharedStateProjectionWithCatalogs;
        useStore.getState().hydrate(projection);
      }
    });
    resetWebMcpRegistry();
    const captured: ReturnType<typeof registerAllTools> = [];
    const adapter = new class extends WebMcpRuntimeAdapter {
      register(tool: (typeof captured)[number]): 'development' { captured.push(tool); return 'development'; }
    }();
    registerAllTools({ client, agentContext: actorContextForAgent('agent-integration'), adapter, force: true });

    await client.invoke('create_job_requisition', {
      title: 'UI Platform Engineer',
      department: 'Engineering',
      requirements: ['TypeScript'],
      compBand: { min: 100, max: 120, currency: 'USD' }
    }, actorContextForRole('recruiter'));
    expect(useStore.getState().jobs.some((job) => job.title === 'UI Platform Engineer')).toBe(true);

    const webTool = captured.find((tool) => tool.name === 'submit_application');
    expect(webTool).toBeDefined();
    await webTool!.execute({ candidateId: 'cand-1', jobId: 'job-1', resumeText: 'Agent-tailored resume' });
    const state = useStore.getState();
    expect(state.applications).toHaveLength(1);
    expect(state.candidates.find((candidate) => candidate.id === 'cand-1')?.resumeTextHistory).toEqual(['Agent-tailored resume']);
    expect(state.activityLog.slice(-2).map((entry) => [entry.toolName, entry.actorType])).toEqual([
      ['create_job_requisition', 'human_ui'],
      ['submit_application', 'agent']
    ]);

    const columns = projectKanban(state.applications);
    expect(columns.find((column) => column.status === 'applied')?.applications).toHaveLength(1);
    expect(projectActivityFeed(state.activityLog)[0].operation).toBe('submit_application');
  });

  it('coalesces SSE revisions and refreshes every store collection from /api/state', async () => {
    const service = new OperationService(new SharedStateRepository(createSeed()), defaultOperationHandlers);
    let source: FakeEventSource | undefined;
    const fetcher: FetchLike = serviceFetch(service);
    const controller = new SynchronizationController({
      fetcher,
      eventSourceFactory: () => {
        source = new FakeEventSource();
        return source;
      }
    });
    await controller.start();
    service.repository.transact((draft) => {
      draft.jobs.get('job-1')!.status = 'paused';
    });
    service.repository.transact((draft) => {
      draft.jobs.get('job-1')!.status = 'closed';
    });
    source!.emit(service.repository.getRevision() - 1);
    source!.emit(service.repository.getRevision());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().revision).toBe(service.repository.getRevision());
    expect(useStore.getState().jobs.find((job) => job.id === 'job-1')?.status).toBe('closed');
    controller.stop();
    expect(source!.closed).toBe(true);
  });

  it('keeps read-only WebMCP operations from changing domain collections', async () => {
    const service = new OperationService(new SharedStateRepository(createSeed()), defaultOperationHandlers);
    const client = new OperationClient({ fetcher: serviceFetch(service), refreshState: async () => undefined });
    resetWebMcpRegistry();
    const tools: ReturnType<typeof registerAllTools> = [];
    const adapter = new class extends WebMcpRuntimeAdapter {
      register(tool: (typeof tools)[number]): 'development' { tools.push(tool); return 'development'; }
    }();
    registerAllTools({ client, adapter, force: true });
    const before = domainCollections(serializeSharedState(service.repository.read()));
    const search = tools.find((tool) => tool.name === 'search_candidates');
    expect(search).toBeDefined();
    const result = await search!.execute({ query: 'backend' });
    expect(result).toHaveProperty('results');
    const after = domainCollections(serializeSharedState(service.repository.read()));
    expect(after).toEqual(before);
    expect(tools).toHaveLength(OPERATION_NAMES.length);
    expect(tools.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
    expect(OPERATION_REGISTRY.search_candidates.annotations).toEqual({
      readOnlyHint: true,
      executionClass: OPERATION_REGISTRY.search_candidates.executionClass,
      requiresApproval: OPERATION_REGISTRY.search_candidates.approvalPolicy !== 'none',
      planable: OPERATION_REGISTRY.search_candidates.planable
    });
  });

  it('registers the native document contract and the legacy navigator polyfill shape', () => {
    const service = new OperationService(new SharedStateRepository(createSeed()), defaultOperationHandlers);
    const client = new OperationClient({ fetcher: serviceFetch(service), refreshState: async () => undefined });
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const nativeCalls: unknown[] = [];
    const polyfillCalls: unknown[] = [];

    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { modelContext: { registerTool: (tool: unknown) => nativeCalls.push(tool) } }
      });
      delete (globalThis as { navigator?: unknown }).navigator;
      registerAllTools({ client, force: true });
      expect(nativeCalls).toHaveLength(OPERATION_NAMES.length);
      expect(nativeCalls[0]).toMatchObject({
        name: 'create_job_requisition',
        inputSchema: OPERATION_REGISTRY.create_job_requisition.inputSchema,
        annotations: { readOnlyHint: false }
      });
      expect(nativeCalls[0]).not.toHaveProperty('schema');
      const nativePublicTool = nativeCalls.find(
        (tool) => (tool as { name?: unknown }).name === 'search_public_candidates'
      ) as { inputSchema?: unknown; annotations?: unknown; execute?: unknown } | undefined;
      expect(nativePublicTool).toMatchObject({
        inputSchema: OPERATION_REGISTRY.search_public_candidates.inputSchema,
        annotations: { readOnlyHint: true }
      });
      expect(nativePublicTool?.execute).toEqual(expect.any(Function));

      delete (globalThis as { document?: unknown }).document;
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { modelContext: { registerTool: (tool: unknown) => polyfillCalls.push(tool) } }
      });
      registerAllTools({ client, force: true });
      expect(polyfillCalls).toHaveLength(OPERATION_NAMES.length);
      expect(polyfillCalls[0]).toMatchObject({
        name: 'create_job_requisition',
        schema: OPERATION_REGISTRY.create_job_requisition.inputSchema,
        annotations: { readOnlyHint: false }
      });
      expect(polyfillCalls[0]).not.toHaveProperty('inputSchema');
      const polyfillPublicTool = polyfillCalls.find(
        (tool) => (tool as { name?: unknown }).name === 'search_public_candidates'
      ) as { schema?: unknown; annotations?: unknown; handler?: unknown } | undefined;
      expect(polyfillPublicTool).toMatchObject({
        schema: OPERATION_REGISTRY.search_public_candidates.inputSchema,
        annotations: { readOnlyHint: true }
      });
      expect(polyfillPublicTool?.handler).toEqual(expect.any(Function));
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      resetWebMcpRegistry();
    }
  });

  it('registers all 20 descriptors in the development fallback registry', () => {
    const service = new OperationService(new SharedStateRepository(createSeed()), defaultOperationHandlers);
    const client = new OperationClient({ fetcher: serviceFetch(service), refreshState: async () => undefined });
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
      delete (globalThis as { document?: unknown }).document;
      delete (globalThis as { navigator?: unknown }).navigator;
      resetWebMcpRegistry();
      registerAllTools({ client, force: true });

      const registry = (globalThis.window as Window).__webmcp_tools ?? {};
      expect(Object.keys(registry)).toEqual(OPERATION_NAMES);
      expect(registry.search_public_candidates).toMatchObject({
        inputSchema: OPERATION_REGISTRY.search_public_candidates.inputSchema,
        schema: OPERATION_REGISTRY.search_public_candidates.inputSchema,
        annotations: { readOnlyHint: true }
      });
      expect(registry.search_public_candidates.execute).toEqual(expect.any(Function));
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      resetWebMcpRegistry();
    }
  });

  it('routes the public prospect descriptor through the canonical operation client with supported input only', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const output = { prospects: [], query: 'backend', filters: { query: 'backend' }, source: 'github' };
    const client = new OperationClient({
      fetcher: async (request, init) => {
        calls.push({ url: String(request), init });
        return jsonResponse(output);
      },
      refreshState: async () => undefined
    });
    const tools: ReturnType<typeof registerAllTools> = [];
    const adapter = new class extends WebMcpRuntimeAdapter {
      register(tool: (typeof tools)[number]): 'development' {
        tools.push(tool);
        return 'development';
      }
    }();

    resetWebMcpRegistry();
    registerAllTools({ client, adapter, force: true });
    const publicTool = tools.find((tool) => tool.name === 'search_public_candidates');
    expect(publicTool).toBeDefined();

    await expect(
      publicTool!.execute({
        query: 'backend',
        language: 'TypeScript',
        location: 'Berlin'
      })
    ).resolves.toEqual(output);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/operations/search_public_candidates');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      input: {
        query: 'backend',
        language: 'TypeScript',
        location: 'Berlin'
      }
    });
    expect(JSON.stringify(JSON.parse(String(calls[0].init?.body)))).not.toContain('experienceLevel');
    expect(JSON.stringify(JSON.parse(String(calls[0].init?.body)))).not.toContain('maxResults');
    expect(new Headers(calls[0].init?.headers).get('x-actor-id')).toBe('agent-demo');
    resetWebMcpRegistry();
  });

  it('observes rejected native registrations without changing synchronous registration', async () => {
    const service = new OperationService(new SharedStateRepository(createSeed()), defaultOperationHandlers);
    const client = new OperationClient({ fetcher: serviceFetch(service), refreshState: async () => undefined });
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const rejection = new Error('native registration rejected');

    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          modelContext: {
            registerTool: () => Promise.reject(rejection)
          }
        }
      });
      delete (globalThis as { navigator?: unknown }).navigator;
      resetWebMcpRegistry();

      const tools = registerAllTools({ client, force: true });
      expect(tools).toHaveLength(OPERATION_NAMES.length);
      expect(getWebMcpRegistrationDiagnostics()).toEqual([]);

      await Promise.resolve();

      const diagnostics = getWebMcpRegistrationDiagnostics();
      expect(diagnostics).toHaveLength(OPERATION_NAMES.length);
      expect(diagnostics.map((diagnostic) => diagnostic.toolName)).toEqual(OPERATION_NAMES);
      expect(diagnostics.every((diagnostic) => diagnostic.error === rejection)).toBe(true);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      resetWebMcpRegistry();
    }
  });
});


describe('OperationClient transport boundary', () => {
  it('uses the configured transport for both the operation and authoritative refresh', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (request, init) => {
      const url = String(request);
      calls.push({ url, init });
      if (url.endsWith('/api/state')) {
        return jsonResponse(serializeSharedState(new SharedStateRepository(createSeed()).read()));
      }
      return jsonResponse({ results: [] });
    };
    const client = new OperationClient({
      baseUrl: 'https://pipeline.example.test/',
      fetcher,
      actorContext: actorContextForRole('candidate')
    });

    await expect(client.invoke('search_candidates', { query: 'backend' })).resolves.toEqual({ results: [] });

    expect(calls.map((call) => call.url)).toEqual([
      'https://pipeline.example.test/api/operations/search_candidates',
      'https://pipeline.example.test/api/state'
    ]);
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('x-actor-type')).toBe('human_ui');
    expect(new Headers(calls[0].init?.headers).get('x-actor-id')).toBe('alice-candidate');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ input: { query: 'backend' } });
  });
});
