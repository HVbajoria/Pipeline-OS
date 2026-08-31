import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  PipelineError
} from '../src/shared/errors';
import type { SharedStateWithCatalogs } from '../src/shared/models';
import {
  OperationService,
  type OperationHandler
} from '../src/server/operationService';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { StateEventPublisher } from '../src/server/events';
import { createTestContext } from './factories';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let httpServer: Server;
let httpApp: Express;
let httpApi: PipelineApi;
let baseUrl: string;

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(payload === undefined ? {} : {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString()
          }),
          ...headers
        }
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            // Preserve non-JSON bodies so a test can detect an accidental HTML error.
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsed
          });
        });
      }
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function expectAuditError(
  snapshot: SharedStateWithCatalogs,
  input: Record<string, unknown>,
  error: PipelineError,
  operation: string
): void {
  expect(snapshot.activityLog).toHaveLength(1);
  expect(snapshot.activityLog[0]).toMatchObject({
    toolName: operation,
    actorType: 'human_ui',
    actorId: 'test-recruiter',
    input,
    output: error.toPayload()
  });
}

async function capturePipelineError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected the operation to reject');
}

describe('OperationService service-level error and dispatch contracts', () => {
  it('returns a 400 validation error before an injected handler runs', async () => {
    const { repository } = createTestContext();
    let called = false;
    const handler: OperationHandler<'search_candidates'> = () => {
      called = true;
      return { results: [] };
    };
    const service = new OperationService(repository, {
      search_candidates: handler
    });
    const input = { query: 17 } as never;

    const thrown = await capturePipelineError(
      service.invoke('search_candidates', input, {
        actorType: 'human_ui',
        actorId: 'test-recruiter'
      })
    );

    expect(thrown.status).toBe(400);
    expect(thrown.code).toBe('VALIDATION_ERROR');
    expect(called).toBe(false);
    expectAuditError(repository.read(), input, thrown, 'search_candidates');
  });

  it('preserves domain state and audits an injected 404 not-found error', async () => {
    const { repository } = createTestContext();
    const before = repository.read();
    const handler: OperationHandler<'get_candidate_profile'> = () => {
      throw new NotFoundError('Candidate not found', {
        recordType: 'Candidate_Record',
        recordId: 'missing-candidate'
      });
    };
    const service = new OperationService(repository, {
      get_candidate_profile: handler
    });
    const input = { candidateId: 'missing-candidate' };

    const thrown = await capturePipelineError(
      service.invoke('get_candidate_profile', input, {
        actorType: 'human_ui',
        actorId: 'test-recruiter'
      })
    );

    expect(thrown.status).toBe(404);
    const after = repository.read();
    expect(after.candidates).toEqual(before.candidates);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.activityLog).toHaveLength(1);
    expectAuditError(after, input, thrown, 'get_candidate_profile');
  });

  it('preserves a mutation draft and audits an injected 409 conflict error', async () => {
    const { repository } = createTestContext();
    const before = repository.read();
    const handler: OperationHandler<'submit_application'> = () => {
      throw new ConflictError('Duplicate application exists', {
        recordType: 'Application_Record'
      });
    };
    const service = new OperationService(repository, {
      submit_application: handler
    });
    const input = {
      candidateId: 'cand-1',
      jobId: 'job-1',
      resumeText: 'A tailored resume'
    };

    const thrown = await capturePipelineError(
      service.invoke('submit_application', input, {
        actorType: 'human_ui',
        actorId: 'test-recruiter'
      })
    );

    expect(thrown.status).toBe(409);
    const after = repository.read();
    expect(after.applications).toEqual(before.applications);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.revision).toBe(1);
    expectAuditError(after, input, thrown, 'submit_application');
  });

  it('turns unexpected exceptions and invalid output serialization into 500 errors', async () => {
    const unexpectedContext = createTestContext();
    const unexpectedService = new OperationService(unexpectedContext.repository, {
      search_candidates: (() => {
        throw new Error('private implementation detail');
      }) as OperationHandler<'search_candidates'>
    });
    const unexpected = await capturePipelineError(
      unexpectedService.invoke('search_candidates', {}, unexpectedContext.actor)
    );

    expect(unexpected).toBeInstanceOf(InternalError);
    expect(unexpected.status).toBe(500);
    expect(unexpected.message).toBe('Internal server error');

    const invalidContext = createTestContext();
    const invalidOutputService = new OperationService(invalidContext.repository, {
      create_job_requisition: (() => ({} as unknown)) as OperationHandler<'create_job_requisition'>
    });
    const invalidOutput = await capturePipelineError(
      invalidOutputService.invoke(
        'create_job_requisition',
        {
          title: 'Platform Engineer',
          department: 'Engineering',
          requirements: ['TypeScript'],
          compBand: { min: 100, max: 120, currency: 'USD' }
        },
        invalidContext.actor
      )
    );

    expect(invalidOutput.status).toBe(500);
    expect(invalidOutput.code).toBe('INTERNAL_ERROR');
    expect(invalidContext.repository.read().jobs.get('job-1')?.status).toBe('open');
    expect(invalidContext.repository.read().activityLog[0].output).toEqual(
      invalidOutput.toPayload()
    );
  });
});

describe('PipelineOS HTTP/API boundary', () => {
  beforeAll(async () => {
    const { repository } = createTestContext();
    httpApi = createPipelineApi({
      repository,
      handlers: {
        search_candidates: (() => ({ results: [] })) as OperationHandler<'search_candidates'>,
        get_candidate_profile: (() => {
          throw new NotFoundError('Candidate not found');
        }) as OperationHandler<'get_candidate_profile'>,
        submit_application: (() => {
          throw new ConflictError('Duplicate application exists');
        }) as OperationHandler<'submit_application'>,
        create_job_requisition: (() => ({} as unknown)) as OperationHandler<'create_job_requisition'>
      }
    });
    httpApp = httpApi.app;
    httpApp.get('/__webmcp-html-test', (_request, response) => {
      response.type('html').send('<!doctype html><html></html>');
    });
    httpServer = createServer(httpApp);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    httpApi.events.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('applies WebMCP eligibility headers to API and downstream HTML responses', async () => {
    const apiResponse = await jsonRequest('GET', '/api/state');
    expect(apiResponse.headers['origin-agent-cluster']).toBe('?1');
    expect(apiResponse.headers['permissions-policy']).toBe('tools=(self)');

    const htmlResponse = await jsonRequest('GET', '/__webmcp-html-test');
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers['origin-agent-cluster']).toBe('?1');
    expect(htmlResponse.headers['permissions-policy']).toBe('tools=(self)');
    expect(htmlResponse.body).toContain('<!doctype html>');
  });

  it('dispatches canonical and compatibility requests through the same service and actor audit path', async () => {
    const canonical = await jsonRequest(
      'POST',
      '/api/operations/search_candidates',
      { input: {} },
      { 'x-actor-type': 'agent', 'x-actor-id': 'agent-test' }
    );
    expect(canonical.status).toBe(200);
    expect(canonical.body).toEqual({ results: [] });

    const compatibility = await jsonRequest(
      'POST',
      '/api/candidates/search',
      { query: '' },
      { 'x-actor-type': 'human_ui', 'x-actor-id': 'ui-test' }
    );
    expect(compatibility.status).toBe(200);
    expect(compatibility.body).toEqual({ results: [] });

    const log = httpApi.repository.read().activityLog;
    expect(log.slice(-2).map((entry) => entry.toolName)).toEqual([
      'search_candidates',
      'search_candidates'
    ]);
    expect(log.at(-2)?.actorType).toBe('agent');
    expect(log.at(-2)?.actorId).toBe('agent-test');
    expect(log.at(-1)?.actorType).toBe('human_ui');
    expect(log.at(-1)?.actorId).toBe('ui-test');
  });

  it('serializes validation, not-found, conflict, and internal errors identically', async () => {
    const validation = await jsonRequest(
      'POST',
      '/api/operations/search_candidates',
      { input: { query: 42 } }
    );
    expect(validation.status).toBe(400);
    expect(validation.body).toMatchObject({
      error: { code: 'VALIDATION_ERROR', status: 400 }
    });

    const notFound = await jsonRequest(
      'POST',
      '/api/operations/get_candidate_profile',
      { input: { candidateId: 'missing' } }
    );
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({
      error: {
        code: 'NOT_FOUND_ERROR',
        status: 404,
        message: 'Candidate not found'
      }
    });

    const conflict = await jsonRequest(
      'POST',
      '/api/operations/submit_application',
      {
        input: {
          candidateId: 'cand-1',
          jobId: 'job-1',
          resumeText: 'Resume'
        }
      }
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: {
        code: 'CONFLICT_ERROR',
        status: 409,
        message: 'Duplicate application exists'
      }
    });

    const internal = await jsonRequest(
      'POST',
      '/api/operations/create_job_requisition',
      {
        input: {
          title: 'Platform Engineer',
          department: 'Engineering',
          requirements: ['TypeScript'],
          compBand: { min: 100, max: 120, currency: 'USD' }
        }
      }
    );
    expect(internal.status).toBe(500);
    expect(internal.body).toMatchObject({
      error: { code: 'INTERNAL_ERROR', status: 500 }
    });
    expect(typeof (internal.body as { error: { message: string } }).error.message).toBe(
      'string'
    );

    const latest = httpApi.repository.read().activityLog;
    expect(latest.slice(-4).map((entry) => entry.output)).toEqual([
      validation.body,
      notFound.body,
      conflict.body,
      internal.body
    ]);
  });

  it('returns array-shaped state, resets through the repository, and emits revision-only events', async () => {
    const stateBefore = await jsonRequest('GET', '/api/state');
    expect(stateBefore.status).toBe(200);
    expect(Array.isArray((stateBefore.body as { jobs: unknown[] }).jobs)).toBe(true);
    expect(Array.isArray((stateBefore.body as { activityLog: unknown[] }).activityLog)).toBe(
      true
    );
    expect((stateBefore.body as { catalogs: unknown }).catalogs).toBeDefined();

    const received: unknown[] = [];
    const unsubscribe = httpApi.events.subscribe((event) => received.push(event));
    const reset = await jsonRequest('POST', '/api/reset', {});
    unsubscribe();

    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ success: true });
    expect(received.at(-1)).toEqual({
      type: 'state_changed',
      revision: httpApi.repository.getRevision()
    });
    expect(httpApi.repository.read().activityLog).toEqual([]);

    const eventPublisher = new StateEventPublisher(httpApi.repository);
    const directEvents: unknown[] = [];
    const stop = eventPublisher.subscribe((event) => directEvents.push(event));
    httpApi.repository.appendActivity({
      id: 'event-test',
      toolName: 'search_candidates',
      actorType: 'human_ui',
      actorId: 'test-recruiter',
      input: {},
      output: { results: [] },
      timestamp: '2026-01-01T00:00:00.000Z'
    });
    stop();
    eventPublisher.close();

    expect(directEvents).toHaveLength(1);
    expect(directEvents[0]).toEqual({
      type: 'state_changed',
      revision: httpApi.repository.getRevision()
    });
    expect(JSON.stringify(directEvents[0])).not.toContain('event-test');
  });
});
