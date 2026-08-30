import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import { actorContextForAgent } from '../src/client/actorContext';
import { PipelineError } from '../src/shared/errors';
import type { ActorContext, SharedStateWithCatalogs } from '../src/shared/models';
import { OPERATION_NAMES, type OperationName } from '../src/shared/operations';
import { serializeSharedState } from '../src/server/api';
import { defaultOperationHandlers } from '../src/server/operations';
import { OperationService } from '../src/server/operationService';
import { SharedStateRepository } from '../src/server/repository';
import { createSeed } from '../src/server/seed';
import { WebMcpRuntimeAdapter, registerAllTools, resetWebMcpRegistry } from '../src/lib/webmcp';
import { assertAsyncProperty } from './factories';
import { DeterministicIdGenerator, FixedClock } from './factories';

interface OperationFixture {
  name: OperationName;
  input: Record<string, unknown>;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function serviceFetch(service: OperationService): FetchLike {
  return async (request, init) => {
    const url = String(request);
    if (url.endsWith('/api/state')) {
      return response(serializeSharedState(service.repository.read()));
    }
    const name = url.split('/').at(-1) as OperationName;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown };
    const actor: ActorContext = {
      actorType: String(init?.headers && new Headers(init.headers).get('x-actor-type')) as ActorContext['actorType'],
      actorId: String(init?.headers && new Headers(init.headers).get('x-actor-id'))
    };
    try {
      const output = await service.invoke(name, body.input as never, actor);
      return response(output);
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return response(pipelineError.toPayload(), pipelineError.status);
    }
  };
}

function domainSnapshot(state: SharedStateWithCatalogs) {
  return {
    jobs: [...state.jobs.values()],
    candidates: [...state.candidates.values()],
    applications: [...state.applications.values()],
    panels: [...state.panels.values()],
    interviews: [...state.interviews.values()],
    scorecards: [...state.scorecards.values()],
    offers: [...state.offers.values()],
    onboardingTasks: [...state.onboardingTasks.values()],
    backgroundChecks: [...state.backgroundChecks.values()],
    benefitsEnrollments: [...state.benefitsEnrollments.values()]
  };
}

function createService(): OperationService {
  return new OperationService(
    new SharedStateRepository(createSeed(), {
      clock: new FixedClock(),
      idGenerator: new DeterministicIdGenerator('equivalence')
    }),
    defaultOperationHandlers
  );
}

const fixtureArbitrary: fc.Arbitrary<OperationFixture> = fc.oneof(
  fc.record({
    name: fc.constant('search_candidates' as const),
    input: fc.record({ query: fc.string(), skills: fc.array(fc.string(), { maxLength: 3 }) })
  }),
  fc.record({
    name: fc.constant('get_candidate_profile' as const),
    input: fc.record({ candidateId: fc.constant('cand-1') })
  }),
  fc.record({
    name: fc.constant('answer_candidate_faq' as const),
    input: fc.record({ jobId: fc.constant('job-1'), question: fc.string({ minLength: 1 }) })
  }),
  fc.record({
    name: fc.constant('check_interviewer_availability' as const),
    input: fc.record({
      panelId: fc.constant('panel-1'),
      dateRange: fc.constant({ start: '2026-09-01T00:00:00Z', end: '2026-09-10T00:00:00Z' })
    })
  }),
  fc.record({
    name: fc.constant('get_interview_kit' as const),
    input: fc.record({ jobId: fc.constant('job-1') })
  }),
  fc.record({
    name: fc.constant('create_job_requisition' as const),
    input: fc.record({
      title: fc.string({ minLength: 1 }),
      department: fc.string({ minLength: 1 }),
      requirements: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
      compBand: fc.record({
        min: fc.integer({ min: 1, max: 1000 }),
        max: fc.integer({ min: 1001, max: 2000 }),
        currency: fc.constant('USD')
      })
    })
  }),
  fc.record({
    name: fc.constant('submit_application' as const),
    input: fc.record({
      candidateId: fc.constant('cand-1'),
      jobId: fc.constant('job-1'),
      resumeText: fc.string({ minLength: 1 })
    })
  })
) as fc.Arbitrary<OperationFixture>;

class CapturingAdapter extends WebMcpRuntimeAdapter {
  readonly tools: ReturnType<typeof registerAllTools> = [];

  override register(tool: (typeof this.tools)[number]): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

// Feature: pipelineos, Property 4: UI/WebMCP operation equivalence
// **Validates: Requirements 2.2, 2.3, 2.4, 2.6, 24.6**
describe('Property 4: UI/WebMCP operation equivalence', () => {
  it('uses the same typed operation boundary and commits equivalent domain state', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        fixtureArbitrary,
        fc.record({ actorId: fc.string({ minLength: 1, maxLength: 16 }) }),
        async (fixture, actorSeed) => {
          resetWebMcpRegistry();
          const uiService = createService();
          const webService = createService();
          const actor = actorContextForAgent(actorSeed.actorId);
          const uiClient = new OperationClient({
            fetcher: serviceFetch(uiService),
            refreshState: async () => undefined
          });
          const webClient = new OperationClient({
            fetcher: serviceFetch(webService),
            refreshState: async () => undefined
          });
          const adapter = new CapturingAdapter();
          registerAllTools({
            client: webClient,
            agentContext: actor,
            adapter,
            force: true
          });

          let uiOutput: unknown;
          let webOutput: unknown;
          let uiError: unknown;
          let webError: unknown;
          try {
            uiOutput = await uiClient.invoke(fixture.name, fixture.input as never, actor);
          } catch (error) {
            uiError = PipelineError.from(error).toPayload();
          }
          try {
            const tool = adapter.tools.find((candidate) => candidate.name === fixture.name);
            if (!tool) throw new Error(`Missing WebMCP descriptor: ${fixture.name}`);
            webOutput = await tool.execute(fixture.input);
          } catch (error) {
            webError = PipelineError.from(error).toPayload();
          }

          expect(webOutput).toEqual(uiOutput);
          expect(webError).toEqual(uiError);
          expect(domainSnapshot(webService.repository.read())).toEqual(
            domainSnapshot(uiService.repository.read())
          );
        }
      )
    );
  });

  it('keeps the shared registry at exactly 19 descriptors', () => {
    resetWebMcpRegistry();
    const adapter = new CapturingAdapter();
    registerAllTools({ adapter, force: true, refreshState: undefined } as never);
    expect(adapter.tools.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
  });
});
