import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  ActorContext
} from '../src/shared/models';
import type { SearchCandidatesInput } from '../src/shared/operations';
import { PipelineError } from '../src/shared/errors';
import {
  OperationService,
  type OperationHandler
} from '../src/server/operationService';
import {
  PROPERTY_RUNS,
  TEST_TIMESTAMP,
  createTestContext
} from './factories';

const actorArbitrary = fc.record({
  actorType: fc.constantFrom<ActorContext['actorType']>('human_ui', 'agent'),
  actorId: fc.string({ minLength: 1, maxLength: 24 }).filter((value) => value.trim().length > 0)
});

describe('OperationService audit contract', () => {
  it('keeps a read-only handler isolated from the committed domain snapshot', async () => {
    const { repository } = createTestContext();
    const handler: OperationHandler<'search_candidates'> = (_input, context) => {
      context.state.candidates.get('cand-1')!.name = 'local-only mutation';
      return { results: [] };
    };
    const service = new OperationService(repository, {
      search_candidates: handler
    });

    await service.invoke('search_candidates', {}, {
      actorType: 'human_ui',
      actorId: 'test-recruiter'
    });

    expect(repository.read().candidates.get('cand-1')?.name).toBe('Ananya Sharma');
  });

  it('audits exactly one success or structured-error entry for every generated invocation', async () => {
    // Feature: pipelineos, Property 5: Exactly-once activity audit
    // **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6, 24.7**
    await fc.assert(
      fc.asyncProperty(actorArbitrary, fc.boolean(), async (actor, shouldFail) => {
        const { repository } = createTestContext({
          timestamp: TEST_TIMESTAMP,
          actor
        });
        const handler: OperationHandler<'search_candidates'> = () => ({
          results: []
        });
        const service = new OperationService(repository, {
          search_candidates: handler
        });
        const input = shouldFail
          ? ({ query: 42 } as unknown as SearchCandidatesInput)
          : ({} satisfies SearchCandidatesInput);

        let result: unknown;
        let thrown: PipelineError | undefined;
        try {
          result = await service.invoke('search_candidates', input, actor);
        } catch (error) {
          thrown = PipelineError.from(error);
        }

        const state = repository.read();
        expect(state.activityLog).toHaveLength(1);
        expect(state.revision).toBe(1);

        const entry = state.activityLog[0];
        expect(entry.toolName).toBe('search_candidates');
        expect(entry.actorType).toBe(actor.actorType);
        expect(entry.actorId).toBe(actor.actorId);
        expect(entry.input).toEqual(input);
        expect(entry.timestamp).toBe(TEST_TIMESTAMP);

        if (shouldFail) {
          expect(thrown).toBeDefined();
          expect(thrown?.status).toBe(400);
          expect(entry.output).toEqual(thrown?.toPayload());
        } else {
          expect(thrown).toBeUndefined();
          expect(result).toEqual({ results: [] });
          expect(entry.output).toEqual(result);
        }
      }),
      { numRuns: PROPERTY_RUNS }
    );
  });
});
