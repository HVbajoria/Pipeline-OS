import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import GitHubProspectsPanel from '../src/components/GitHubProspectsPanel';
import {
  GitHubProspectsClient,
  type GitHubProspectsFetchLike
} from '../src/client/githubProspectsClient';
import {
  buildGitHubUsersSearchQuery,
  buildGitHubUsersSearchUrl,
  GitHubProspectError,
  GitHubProspectService,
  GitHubPublicProspectAdapter,
  type GitHubProspectFetch
} from '../src/server/prospects';
import { createPipelineApi } from '../src/server/api';

const FIRST_FETCHED_AT = '2026-04-01T12:00:00.000Z';
const SECOND_FETCHED_AT = '2026-04-01T12:06:00.000Z';
const TOKEN = 'server-only-test-token';

const githubPayload = {
  total_count: 1,
  incomplete_results: false,
  items: [
    {
      login: 'octocat',
      id: 1,
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      html_url: 'https://github.com/octocat',
      type: 'User',
      score: 42.75,
      location: 'San Francisco',
      bio: 'Builds public software',
      public_repos: 8,
      email: 'must-not-be-copied@example.test'
    }
  ]
};

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function adapterFixtureFetcher(
  payload: unknown = githubPayload
): { fetcher: GitHubProspectFetch; calls: string[]; headers: Headers[] } {
  const calls: string[] = [];
  const headers: Headers[] = [];
  return {
    calls,
    headers,
    fetcher: async (input, init) => {
      calls.push(input);
      headers.push(new Headers(init?.headers));
      return jsonResponse(payload);
    }
  };
}

interface HttpResult {
  status: number;
  body: unknown;
}

let activeServer: Server | undefined;

async function requestJson(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const request = httpRequest(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'application/json', ...headers }
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            body: text.length === 0 ? undefined : JSON.parse(text)
          });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

afterEach(async () => {
  if (!activeServer) return;
  await new Promise<void>((resolve, reject) => {
    activeServer!.close((error) => (error ? reject(error) : resolve()));
  });
  activeServer = undefined;
});

describe('GitHub public prospect adapter', () => {
  it('builds an encoded users query, sends descriptive headers, and allowlists fields', async () => {
    const { fetcher, calls, headers } = adapterFixtureFetcher();
    const adapter = new GitHubPublicProspectAdapter({
      fetcher,
      token: TOKEN,
      clock: { now: () => FIRST_FETCHED_AT }
    });

    const prospects = await adapter.search({
      query: 'backend engineer',
      language: 'TypeScript',
      location: 'New York'
    });

    const requestUrl = new URL(calls[0]);
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      'https://api.github.com/search/users'
    );
    expect(requestUrl.searchParams.get('q')).toBe(
      'backend engineer language:TypeScript location:"New York"'
    );
    expect(requestUrl.searchParams.get('per_page')).toBe('10');
    expect(headers[0].get('accept')).toBe('application/vnd.github+json');
    expect(headers[0].get('user-agent')).toContain('PipelineOS');
    expect(headers[0].get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers[0].get('x-github-api-version')).toBe('2022-11-28');

    expect(prospects[0]).toMatchObject({
      source: 'github',
      sourceUrl: 'https://github.com/octocat',
      profileUrl: 'https://github.com/octocat',
      username: 'octocat',
      login: 'octocat',
      profileType: 'User',
      searchScore: 42.75,
      query: 'backend engineer language:TypeScript location:"New York"',
      fetchedAt: FIRST_FETCHED_AT,
      dataOrigin: 'public_github',
      consentStatus: 'not_provided',
      location: 'San Francisco',
      bio: 'Builds public software',
      publicRepos: 8
    });
    expect(prospects[0]).not.toHaveProperty('email');
    expect(JSON.stringify(prospects)).not.toContain(TOKEN);
  });

  it('normalizes input and URL encoding without making a request during module use', () => {
    expect(buildGitHubUsersSearchQuery({ query: '  TypeScript   API  ' })).toBe(
      'TypeScript API'
    );
    const url = buildGitHubUsersSearchUrl({
      query: 'C++ developer & maintainer',
      location: 'São Paulo'
    }, 5);
    expect(new URL(url).searchParams.get('q')).toBe(
      'C++ developer & maintainer location:"São Paulo"'
    );
    expect(new URL(url).searchParams.get('per_page')).toBe('5');
  });

  it('classifies rate limits, non-2xx responses, invalid JSON, and malformed payloads', async () => {
    const rateLimited = new GitHubPublicProspectAdapter({
      fetcher: async () =>
        jsonResponse(
          { message: 'API rate limit exceeded' },
          403,
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1775048400' }
        )
    });
    await expect(rateLimited.search({ query: 'typescript' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { resetAt: expect.any(String) }
    });

    const httpFailure = new GitHubPublicProspectAdapter({
      fetcher: async () => jsonResponse({ message: 'bad gateway' }, 503)
    });
    await expect(httpFailure.search({ query: 'typescript' })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 502
    });

    const invalidJson = new GitHubPublicProspectAdapter({
      fetcher: async () => new Response('{', { status: 200 })
    });
    await expect(invalidJson.search({ query: 'typescript' })).rejects.toMatchObject({
      code: 'INVALID_JSON',
      status: 502
    });

    const malformed = new GitHubPublicProspectAdapter({
      fetcher: async () => jsonResponse({ items: [{ login: 'missing-score' }] })
    });
    await expect(malformed.search({ query: 'typescript' })).rejects.toMatchObject({
      code: 'MALFORMED_PAYLOAD',
      status: 502
    });
  });
});

describe('GitHub prospect cache/service', () => {
  it('serves cache hits, refreshes after TTL, deduplicates concurrent requests, and does not cache errors', async () => {
    let now = FIRST_FETCHED_AT;
    let calls = 0;
    const service = new GitHubProspectService({
      cacheTtlMs: 5 * 60 * 1000,
      clock: { now: () => now },
      fetcher: async () => {
        calls += 1;
        return jsonResponse(githubPayload);
      }
    });

    const first = await service.search({ query: 'backend' });
    expect(first.cache).toMatchObject({ hit: false, coalesced: false, ttlMs: 300000 });
    const cached = await service.search({ query: ' BACKEND ' });
    expect(cached.cache).toMatchObject({ hit: true, coalesced: false });
    expect(calls).toBe(1);

    now = SECOND_FETCHED_AT;
    const refreshed = await service.search({ query: 'backend' });
    expect(refreshed.cache.hit).toBe(false);
    expect(calls).toBe(2);

    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let concurrentCalls = 0;
    const concurrentService = new GitHubProspectService({
      clock: { now: () => FIRST_FETCHED_AT },
      fetcher: async () => {
        concurrentCalls += 1;
        return gate;
      }
    });
    const firstRequest = concurrentService.search({ query: 'react' });
    const secondRequest = concurrentService.search({ query: ' React ' });
    await Promise.resolve();
    expect(concurrentCalls).toBe(1);
    release(jsonResponse(githubPayload));
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      firstRequest,
      secondRequest
    ]);
    expect(firstConcurrent.cache.coalesced).toBe(false);
    expect(secondConcurrent.cache).toMatchObject({ hit: true, coalesced: true });
  });

  it('retries an upstream failure instead of caching the error', async () => {
    let calls = 0;
    const service = new GitHubProspectService({
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ items: 'malformed' });
        return jsonResponse(githubPayload);
      }
    });
    await expect(service.search({ query: 'retry' })).rejects.toBeInstanceOf(
      GitHubProspectError
    );
    await expect(service.search({ query: 'retry' })).resolves.toMatchObject({
      prospects: [expect.objectContaining({ login: 'octocat' })]
    });
    expect(calls).toBe(2);
  });
});

describe('GET /api/prospects/github', () => {
  it('validates recruiter access and returns structured cached catalog output', async () => {
    const { fetcher } = adapterFixtureFetcher();
    const api = createPipelineApi({
      githubProspects: new GitHubProspectService({
        fetcher,
        clock: { now: () => FIRST_FETCHED_AT }
      })
    });
    activeServer = createServer(api.app);
    await new Promise<void>((resolve) => activeServer!.listen(0, '127.0.0.1', resolve));
    const address = activeServer.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const success = await requestJson(
      baseUrl,
      '/api/prospects/github?query=backend%20engineer&language=TypeScript&location=New%20York'
    );
    expect(success.status).toBe(200);
    expect(success.body).toMatchObject({
      source: 'github',
      query: 'backend engineer language:TypeScript location:"New York"',
      filters: { query: 'backend engineer', language: 'TypeScript', location: 'New York' },
      fetchedAt: FIRST_FETCHED_AT,
      prospects: [expect.objectContaining({ dataOrigin: 'public_github' })],
      cache: expect.objectContaining({ ttlMs: 300000 }),
      attribution: expect.objectContaining({ source: 'github' })
    });

    const invalid = await requestJson(baseUrl, '/api/prospects/github');
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const agent = await requestJson(
      baseUrl,
      '/api/prospects/github?query=backend',
      { 'x-actor-type': 'agent', 'x-actor-id': 'agent-not-authorized' }
    );
    expect(agent.status).toBe(403);
    expect(agent.body).toMatchObject({ error: { code: 'FORBIDDEN_ERROR' } });
  });
});

describe('GitHub prospect browser client and recruiter panel', () => {
  it('uses the canonical operation route with browser-safe actor and supported input data', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: GitHubProspectsFetchLike = async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({
        source: 'github',
        query: 'typescript',
        filters: { query: 'typescript', location: 'New York' },
        fetchedAt: FIRST_FETCHED_AT,
        prospects: [],
        cache: {
          hit: false,
          coalesced: false,
          ageMs: 0,
          ttlMs: 300000,
          fetchedAt: FIRST_FETCHED_AT,
          expiresAt: SECOND_FETCHED_AT
        },
        attribution: {
          source: 'github',
          apiUrl: 'https://api.github.com/search/users',
          searchApiDocsUrl: 'https://docs.github.com/en/rest/search/search',
          rateLimitsDocsUrl: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
          userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
        }
      });
    };
    const client = new GitHubProspectsClient({
      fetcher,
      refreshState: async () => undefined
    });
    await client.search({ query: 'typescript', location: 'New York' });

    expect(requests[0].url).toBe('/api/operations/search_public_candidates');
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      input: { query: 'typescript', location: 'New York' }
    });
    const headers = new Headers(requests[0].init?.headers);
    expect(headers.get('x-actor-type')).toBe('human_ui');
    expect(headers.get('x-actor-id')).toBe('sarah-recruiter');
    expect(headers.get('authorization')).toBeNull();
    expect(requests[0].url).not.toContain('/api/prospects/github');
  });

  it('renders the explicit recruiter search and consent boundary without an import action', () => {
    const client = new GitHubProspectsClient({
      fetcher: async () => jsonResponse({})
    });
    const markup = renderToStaticMarkup(
      createElement(GitHubProspectsPanel, { client })
    );
    expect(markup).toContain('Public GitHub prospects');
    expect(markup).toContain('Search GitHub');
    expect(markup).toContain('not a candidate database');
    expect(markup).toContain('provide consent');
    expect(markup).not.toContain('Import to candidate');
  });
});
