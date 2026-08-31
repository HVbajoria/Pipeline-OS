import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActorContext, SharedStateWithCatalogs } from '../src/shared/models';
import type { GitHubProspectSearchResult } from '../src/shared/publicProspects';
import {
  GitHubProspectError,
  type GitHubProspectSearchInput,
  type GitHubProspectServiceApi
} from '../src/server/prospects';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { createTestContext } from './factories';

const FETCHED_AT = '2026-04-01T12:00:00.000Z';
const EXPIRES_AT = '2026-04-01T12:05:00.000Z';

function resultFor(input: GitHubProspectSearchInput): GitHubProspectSearchResult {
  const query = [
    input.query,
    input.language === undefined ? undefined : `language:${input.language}`,
    input.location === undefined ? undefined : `location:${input.location}`
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return {
    prospects: [],
    query,
    filters: { ...input },
    source: 'github',
    fetchedAt: FETCHED_AT,
    cache: {
      hit: false,
      coalesced: false,
      ageMs: 0,
      ttlMs: 300000,
      fetchedAt: FETCHED_AT,
      expiresAt: EXPIRES_AT
    },
    attribution: {
      source: 'github',
      apiUrl: 'https://api.github.com/search/users',
      searchApiDocsUrl: 'https://docs.github.com/en/rest/search/search',
      rateLimitsDocsUrl:
        'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
      userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
    }
  };
}

class FakeGitHubProspectService implements GitHubProspectServiceApi {
  readonly calls: GitHubProspectSearchInput[] = [];
  error: unknown;

  async search(input: GitHubProspectSearchInput): Promise<GitHubProspectSearchResult> {
    this.calls.push({ ...input });
    if (this.error !== undefined) throw this.error;
    return resultFor(input);
  }

  clearCache(): void {
    // The operation does not need cache control; this method satisfies the
    // injected service boundary without introducing a network dependency.
  }
}

interface HttpResult {
  status: number;
  body: unknown;
}

let activeServer: Server | undefined;
let activeApi: PipelineApi | undefined;

function requestJson(
  baseUrl: string,
  method: 'GET' | 'POST',
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
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : {
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
            // Preserve non-JSON bodies so accidental bypasses are visible.
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function startApi(
  service: FakeGitHubProspectService
): Promise<{ api: PipelineApi; baseUrl: string }> {
  const api = createPipelineApi({ githubProspects: service });
  const server = createServer(api.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  activeServer = server;
  activeApi = api;
  return { api, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopApi(): Promise<void> {
  activeApi?.events.close();
  activeApi = undefined;
  if (activeServer === undefined) return;
  const server = activeServer;
  activeServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await stopApi();
});

function domainCollections(state: SharedStateWithCatalogs) {
  return {
    jobs: state.jobs,
    candidates: state.candidates,
    applications: state.applications,
    panels: state.panels,
    interviews: state.interviews,
    scorecards: state.scorecards,
    offers: state.offers,
    onboardingTasks: state.onboardingTasks,
    backgroundChecks: state.backgroundChecks,
    benefitsEnrollments: state.benefitsEnrollments
  };
}

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorType: 'human_ui',
    actorId: 'sarah-recruiter',
    ...overrides
  };
}

describe('search_public_candidates server operation', () => {
  it('uses the injected service, preserves domain collections, and audits exact output', async () => {
    const context = createTestContext({ actor: actor() });
    const fake = new FakeGitHubProspectService();
    const api = createPipelineApi({
      repository: context.repository,
      githubProspects: fake
    });
    const before = context.repository.read();
    const input = {
      query: '  backend   engineer  ',
      language: ' TypeScript '
    };

    const output = await api.operationService.invoke(
      'search_public_candidates',
      input,
      context.actor
    );
    const after = context.repository.read();

    expect(fake.calls).toEqual([
      { query: 'backend engineer', language: 'TypeScript' }
    ]);
    expect(output).toEqual(
      resultFor({ query: 'backend engineer', language: 'TypeScript' })
    );
    expect(domainCollections(after)).toEqual(domainCollections(before));
    expect(after.revision).toBe(before.revision + 1);
    expect(after.activityLog).toHaveLength(1);
    expect(after.activityLog[0]).toMatchObject({
      toolName: 'search_public_candidates',
      actorType: 'human_ui',
      actorId: 'sarah-recruiter',
      input: { query: 'backend engineer', language: 'TypeScript' },
      output
    });
    expect(JSON.stringify(after)).not.toContain('GITHUB_TOKEN');
  });

  it('permits the authorized agent and audits a forbidden actor without calling GitHub', async () => {
    const fake = new FakeGitHubProspectService();
    const api = createPipelineApi({ githubProspects: fake });

    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript' },
        actor({ actorType: 'agent', actorId: 'agent-demo' })
      )
    ).resolves.toMatchObject({ source: 'github' });

    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript' },
        actor({ actorType: 'agent', actorId: 'agent-not-authorized' })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ERROR', status: 403 });

    expect(fake.calls).toHaveLength(1);
    const entries = api.repository.read().activityLog;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      toolName: 'search_public_candidates',
      actorType: 'agent',
      actorId: 'agent-not-authorized',
      output: {
        error: { code: 'FORBIDDEN_ERROR', status: 403 }
      }
    });
    api.events.close();
  });

  it('audits validation failures before the injected service is called', async () => {
    const fake = new FakeGitHubProspectService();
    const api = createPipelineApi({ githubProspects: fake });

    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript', maxResults: 10 } as never,
        actor()
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

    expect(fake.calls).toHaveLength(0);
    const entry = api.repository.read().activityLog[0];
    expect(entry).toMatchObject({
      toolName: 'search_public_candidates',
      output: { error: { code: 'VALIDATION_ERROR', status: 400 } }
    });
    api.events.close();
  });

  it('maps injected rate-limit and upstream failures to safe audited errors', async () => {
    const fake = new FakeGitHubProspectService();
    const api = createPipelineApi({ githubProspects: fake });

    fake.error = new GitHubProspectError(
      'RATE_LIMITED',
      'GitHub API rate limit reached; try again later',
      429,
      { retryAfterSeconds: 30 }
    );
    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript' },
        actor()
      )
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED_ERROR',
      status: 429,
      details: { source: 'github', retryAfterSeconds: 30 }
    });

    fake.error = new GitHubProspectError(
      'HTTP_ERROR',
      'GitHub users search returned HTTP 502',
      502,
      { status: 502 }
    );
    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript' },
        actor()
      )
    ).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      status: 502,
      details: { source: 'github', status: 502 }
    });

    const entries = api.repository.read().activityLog;
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.toolName === 'search_public_candidates')).toBe(
      true
    );
    expect(JSON.stringify(entries)).not.toContain('Authorization');
    api.events.close();
  });
});

describe('search_public_candidates HTTP adapters', () => {
  it('routes canonical POST and compatibility GET through OperationService with one audit per invocation', async () => {
    const fake = new FakeGitHubProspectService();
    const { api, baseUrl } = await startApi(fake);

    const canonical = await requestJson(
      baseUrl,
      'POST',
      '/api/operations/search_public_candidates',
      { input: { query: '  backend  ', location: ' New York ' } },
      { 'x-actor-type': 'agent', 'x-actor-id': 'agent-demo' }
    );
    const compatibility = await requestJson(
      baseUrl,
      'GET',
      '/api/prospects/github?query=backend&location=New%20York',
      undefined,
      { 'x-actor-type': 'human_ui', 'x-actor-id': 'sarah-recruiter' }
    );

    expect(canonical.status).toBe(200);
    expect(compatibility.status).toBe(200);
    expect(canonical.body).toEqual(
      resultFor({ query: 'backend', location: 'New York' })
    );
    expect(compatibility.body).toEqual(
      resultFor({ query: 'backend', location: 'New York' })
    );
    expect(fake.calls).toEqual([
      { query: 'backend', location: 'New York' },
      { query: 'backend', location: 'New York' }
    ]);

    const entries = api.repository.read().activityLog;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.toolName)).toEqual([
      'search_public_candidates',
      'search_public_candidates'
    ]);
    expect(entries.map((entry) => entry.actorId)).toEqual([
      'agent-demo',
      'sarah-recruiter'
    ]);
    expect(entries.map((entry) => entry.output)).toEqual([
      canonical.body,
      compatibility.body
    ]);
  });

  it('keeps compatibility validation, authorization, and upstream mappings on the shared audit path', async () => {
    const fake = new FakeGitHubProspectService();
    const { api, baseUrl } = await startApi(fake);

    const invalid = await requestJson(
      baseUrl,
      'GET',
      '/api/prospects/github?maxResults=10',
      undefined,
      { 'x-actor-type': 'human_ui', 'x-actor-id': 'sarah-recruiter' }
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      error: { code: 'VALIDATION_ERROR', status: 400 }
    });

    const forbidden = await requestJson(
      baseUrl,
      'GET',
      '/api/prospects/github?query=typescript',
      undefined,
      { 'x-actor-type': 'agent', 'x-actor-id': 'agent-not-authorized' }
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({
      error: { code: 'FORBIDDEN_ERROR', status: 403 }
    });

    fake.error = new GitHubProspectError(
      'RATE_LIMITED',
      'GitHub API rate limit reached; try again later',
      429,
      { retryAfterSeconds: 20 }
    );
    const rateLimited = await requestJson(
      baseUrl,
      'GET',
      '/api/prospects/github?query=typescript'
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body).toMatchObject({
      error: {
        code: 'RATE_LIMITED_ERROR',
        status: 429,
        details: { source: 'github', retryAfterSeconds: 20 }
      }
    });

    fake.error = new GitHubProspectError(
      'FETCH_ERROR',
      'GitHub users search request failed',
      502
    );
    const upstream = await requestJson(
      baseUrl,
      'POST',
      '/api/operations/search_public_candidates',
      { input: { query: 'typescript' } }
    );
    expect(upstream.status).toBe(502);
    expect(upstream.body).toMatchObject({
      error: { code: 'UPSTREAM_ERROR', status: 502 }
    });

    expect(fake.calls).toHaveLength(2);
    expect(api.repository.read().activityLog).toHaveLength(4);
    expect(api.repository.read().activityLog.map((entry) => entry.output)).toEqual([
      invalid.body,
      forbidden.body,
      rateLimited.body,
      upstream.body
    ]);
  });

  it('supports configured authorized agent IDs without exposing service configuration', async () => {
    const fake = new FakeGitHubProspectService();
    const api = createPipelineApi({
      githubProspects: fake,
      githubProspectAuthorization: { authorizedAgentIds: ['agent-ci'] }
    });

    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript' },
        actor({ actorType: 'agent', actorId: 'agent-ci' })
      )
    ).resolves.toMatchObject({ source: 'github' });
    await expect(
      api.operationService.invoke(
        'search_public_candidates',
        { query: 'typescript' },
        actor({ actorType: 'agent', actorId: 'agent-demo' })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ERROR', status: 403 });
    expect(JSON.stringify(api.repository.read())).not.toContain('GITHUB_TOKEN');
    api.events.close();
  });
});
