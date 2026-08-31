import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationClient, type FetchLike } from '../src/client/operationClient';
import {
  registerAllTools,
  resetWebMcpRegistry,
  WebMcpRuntimeAdapter,
  type WebMcpRegisteredTool
} from '../src/lib/webmcp';
import { createPipelineApi, type PipelineApi } from '../src/server/api';
import {
  GitHubProspectError,
  GitHubProspectService,
  type GitHubProspectServiceApi
} from '../src/server/prospects';
import {
  PipelineError,
  type PipelineErrorPayload
} from '../src/shared/errors';
import type {
  ActorContext,
  SharedStateWithCatalogs
} from '../src/shared/models';
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  type OperationName
} from '../src/shared/operations';
import type {
  GitHubProspectSearchInput,
  GitHubProspectSearchResult
} from '../src/shared/publicProspects';
import {
  createTestContext,
  PROPERTY_TEST_OPTIONS,
  TEST_TIMESTAMP
} from './factories';

const PUBLIC_OPERATION = 'search_public_candidates' as const;
const EXPIRES_AT = '2026-01-01T00:05:00.000Z';
const SECRET = 'server-only-secret-7f2c';
const EMAIL = 'private-person@example.test';
const PHONE = '+1 555 010 2040';
const RESUME = 'private resume and contact record';
const PRIVATE_PROFILE = 'private-profile-marker';
const CONTACT = 'contact-record-marker';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = { 'content-type': 'application/json' }
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function exactGitHubQuery(input: GitHubProspectSearchInput): string {
  return [
    input.query,
    input.language === undefined ? undefined : `language:${input.language}`,
    input.location === undefined ? undefined : `location:${input.location}`
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

function safeResult(input: GitHubProspectSearchInput): GitHubProspectSearchResult {
  const query = exactGitHubQuery(input);
  return {
    prospects: [
      {
        source: 'github',
        sourceUrl: 'https://github.com/public-user',
        profileUrl: 'https://github.com/public-user',
        username: 'public-user',
        login: 'public-user',
        profileType: 'User',
        searchScore: 42.5,
        query,
        fetchedAt: TEST_TIMESTAMP,
        dataOrigin: 'public_github',
        consentStatus: 'not_provided',
        publicRepos: 3
      }
    ],
    query,
    filters: { ...input },
    source: 'github',
    fetchedAt: TEST_TIMESTAMP,
    cache: {
      hit: false,
      coalesced: false,
      ageMs: 0,
      ttlMs: 300000,
      fetchedAt: TEST_TIMESTAMP,
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

type InjectedOutcome = 'success' | 'rate_limited' | 'upstream';

class InjectedPublicProspectService implements GitHubProspectServiceApi {
  calls = 0;

  constructor(private readonly outcome: InjectedOutcome) {}

  async search(input: GitHubProspectSearchInput): Promise<GitHubProspectSearchResult> {
    this.calls += 1;
    if (this.outcome === 'rate_limited') {
      throw new GitHubProspectError(
        'RATE_LIMITED',
        'upstream body contains no browser-safe details',
        429,
        { retryAfterSeconds: 30 }
      );
    }
    if (this.outcome === 'upstream') {
      throw new GitHubProspectError(
        'HTTP_ERROR',
        'upstream body contains no browser-safe details',
        502,
        { status: 503 }
      );
    }
    return safeResult(input);
  }

  clearCache(): void {
    // This fake intentionally has no cache; cache/coalescing are covered by
    // the injected GitHubProspectService tests in github-prospects.test.ts.
  }
}

function domainCollections(state: SharedStateWithCatalogs) {
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

function directOperationFetcher(service: PipelineApi['operationService']): FetchLike {
  return async (request, init) => {
    const url = new URL(String(request), 'https://pipelineos.test');
    const operationName = url.pathname.split('/').at(-1) as OperationName;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input: unknown };
    const headers = new Headers(init?.headers);
    const actor: ActorContext = {
      actorType: (headers.get('x-actor-type') ?? 'human_ui') as ActorContext['actorType'],
      actorId: headers.get('x-actor-id') ?? 'unknown-actor'
    };

    try {
      const output = await service.invoke(
        operationName,
        body.input as never,
        actor
      );
      return jsonResponse(output);
    } catch (error) {
      const pipelineError = PipelineError.from(error);
      return jsonResponse(pipelineError.toPayload(), pipelineError.status);
    }
  };
}

interface CapturedOutcome {
  ok: boolean;
  value?: unknown;
  error?: PipelineErrorPayload;
}

async function capture(
  callback: () => Promise<unknown>
): Promise<CapturedOutcome> {
  try {
    return { ok: true, value: await callback() };
  } catch (error) {
    return { ok: false, error: PipelineError.from(error).toPayload() };
  }
}

class CollectingWebMcpAdapter extends WebMcpRuntimeAdapter {
  readonly tools: WebMcpRegisteredTool[] = [];

  override register(tool: WebMcpRegisteredTool): 'development' {
    this.tools.push(tool);
    return 'development';
  }
}

const queryArbitrary = fc
  .array(
    fc.constantFrom('backend', 'engineer', 'typescript', 'api', 'react', 'python'),
    { minLength: 1, maxLength: 3 }
  )
  .map((words) => words.join(' '));
const optionalFilterArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom('TypeScript', 'Go', 'Python', 'Berlin', 'New York')
);
const publicInputArbitrary = fc
  .tuple(queryArbitrary, optionalFilterArbitrary, optionalFilterArbitrary)
  .map(([query, language, location]) => ({
    query,
    ...(language === undefined ? {} : { language }),
    ...(location === undefined ? {} : { location })
  }));
const authorizedActorArbitrary = fc.constantFrom<ActorContext>(
  { actorType: 'human_ui', actorId: 'sarah-recruiter' },
  { actorType: 'agent', actorId: 'agent-demo' }
);
const injectedOutcomeArbitrary = fc.constantFrom<InjectedOutcome>(
  'success',
  'rate_limited',
  'upstream'
);

function createPublicApi(
  service: GitHubProspectServiceApi,
  actor: ActorContext
): PipelineApi {
  const context = createTestContext({ actor });
  return createPipelineApi({
    repository: context.repository,
    githubProspects: service
  });
}

function expectedOutcomePayload(
  outcome: InjectedOutcome,
  input: GitHubProspectSearchInput
): unknown {
  if (outcome === 'success') return safeResult(input);
  if (outcome === 'rate_limited') {
    return {
      error: {
        code: 'RATE_LIMITED_ERROR',
        status: 429,
        message: 'GitHub API rate limit reached; try again later',
        details: {
          source: 'github',
          upstreamCode: 'RATE_LIMITED',
          retryAfterSeconds: 30
        }
      }
    };
  }
  return {
    error: {
      code: 'UPSTREAM_ERROR',
      status: 502,
      message: 'GitHub public-prospect service unavailable',
      details: {
        source: 'github',
        upstreamCode: 'HTTP_ERROR',
        status: 503
      }
    }
  };
}

describe('search_public_candidates focused operation coverage', () => {
  it('keeps the public contract allowlisted across output, audit, errors, and browser descriptors', async () => {
    const payload = {
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          login: 'public-user',
          html_url: 'https://github.com/public-user',
          avatar_url: 'https://avatars.githubusercontent.com/u/1',
          type: 'User',
          score: 91.25,
          public_repos: 4,
          email: EMAIL,
          phone: PHONE,
          private: true,
          private_profile: PRIVATE_PROFILE,
          resume: RESUME,
          contact: CONTACT,
          bio: `Public bio ${EMAIL}`,
          location: `Public location ${PHONE}`
        }
      ]
    };
    let authorizationHeader: string | null = null;
    const service = new GitHubProspectService({
      token: SECRET,
      clock: { now: () => TEST_TIMESTAMP },
      fetcher: async (_url, init) => {
        authorizationHeader = new Headers(init?.headers).get('authorization');
        return jsonResponse(payload);
      }
    });
    const actor: ActorContext = {
      actorType: 'human_ui',
      actorId: 'sarah-recruiter'
    };
    const api = createPublicApi(service, actor);

    try {
      const output = await api.operationService.invoke(
        PUBLIC_OPERATION,
        { query: 'backend' },
        actor
      );
      const snapshot = api.repository.read();
      const prospect = output.prospects[0];
      const publicDescriptor = JSON.stringify(
        OPERATION_REGISTRY[PUBLIC_OPERATION]
      );
      const browserSource = [
        readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'),
        readFileSync(new URL('../src/lib/webmcp.ts', import.meta.url), 'utf8'),
        readFileSync(new URL('../src/client/githubProspectsClient.ts', import.meta.url), 'utf8')
      ].join('\n');

      expect(authorizationHeader).toBe(`Bearer ${SECRET}`);
      expect(prospect).toMatchObject({
        source: 'github',
        username: 'public-user',
        login: 'public-user',
        profileType: 'User',
        searchScore: 91.25,
        dataOrigin: 'public_github',
        consentStatus: 'not_provided'
      });
      expect(prospect).not.toHaveProperty('email');
      expect(prospect).not.toHaveProperty('phone');
      expect(prospect).not.toHaveProperty('private');
      expect(prospect).not.toHaveProperty('private_profile');
      expect(prospect).not.toHaveProperty('resume');
      expect(prospect).not.toHaveProperty('contact');
      expect(prospect).not.toHaveProperty('bio');
      expect(prospect).not.toHaveProperty('location');

      const serializedPublicData = JSON.stringify({ output, activity: snapshot.activityLog });
      for (const forbiddenValue of [
        SECRET,
        EMAIL,
        PHONE,
        RESUME,
        PRIVATE_PROFILE,
        CONTACT
      ]) {
        expect(serializedPublicData).not.toContain(forbiddenValue);
      }
      expect(publicDescriptor).not.toMatch(/email|phone|private|resume|contact/iu);
      expect(browserSource).not.toContain('https://api.github.com/search/users');
      expect(browserSource).not.toContain('/api/prospects/github');
      expect(browserSource).not.toContain(SECRET);
      expect(snapshot.activityLog).toHaveLength(1);
      expect(snapshot.activityLog[0]).toMatchObject({
        toolName: PUBLIC_OPERATION,
        actorType: actor.actorType,
        actorId: actor.actorId,
        input: { query: 'backend' },
        output
      });
    } finally {
      api.events.close();
    }
  });

  it.each([
    ['HTTP', () => jsonResponse({ message: `bad gateway ${SECRET} ${EMAIL}` }, 503)],
    ['JSON', () => new Response(`not-json ${SECRET} ${RESUME}`, { status: 200 })],
    [
      'payload',
      () =>
        jsonResponse({
          items: [
            {
              login: 'missing-required-fields',
              resume: RESUME,
              contact: CONTACT
            }
          ]
        })
    ]
  ])('maps %s upstream failures to a safe audited 502 operation error', async (_name, responseFactory) => {
    const service = new GitHubProspectService({
      token: SECRET,
      clock: { now: () => TEST_TIMESTAMP },
      fetcher: async () => responseFactory()
    });
    const actor: ActorContext = {
      actorType: 'human_ui',
      actorId: 'sarah-recruiter'
    };
    const api = createPublicApi(service, actor);

    try {
      await expect(
        api.operationService.invoke(PUBLIC_OPERATION, { query: 'backend' }, actor)
      ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', status: 502 });
      const snapshot = api.repository.read();
      const serialized = JSON.stringify(snapshot.activityLog);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain(RESUME);
      expect(serialized).not.toContain(CONTACT);
      expect(snapshot.activityLog).toHaveLength(1);
      expect(snapshot.activityLog[0].output).toMatchObject({
        error: { code: 'UPSTREAM_ERROR', status: 502 }
      });
    } finally {
      api.events.close();
    }
  });

  it('keeps validation, authorization, and rate-limit failures on the one-audit/no-domain-mutation path', async () => {
    const service = new InjectedPublicProspectService('rate_limited');
    const authorized: ActorContext = {
      actorType: 'human_ui',
      actorId: 'sarah-recruiter'
    };
    const unauthorized: ActorContext = {
      actorType: 'agent',
      actorId: 'agent-not-authorized'
    };
    const api = createPublicApi(service, authorized);
    const before = domainCollections(api.repository.read());

    try {
      await expect(
        api.operationService.invoke(
          PUBLIC_OPERATION,
          { query: 'backend', maxResults: 10 } as never,
          authorized
        )
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
      await expect(
        api.operationService.invoke(
          PUBLIC_OPERATION,
          { query: 'backend' },
          unauthorized
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN_ERROR', status: 403 });
      await expect(
        api.operationService.invoke(
          PUBLIC_OPERATION,
          { query: 'backend' },
          authorized
        )
      ).rejects.toMatchObject({ code: 'RATE_LIMITED_ERROR', status: 429 });

      const after = api.repository.read();
      expect(domainCollections(after)).toEqual(before);
      expect(service.calls).toBe(1);
      expect(after.activityLog).toHaveLength(3);
      expect(after.activityLog.map((entry) => entry.output)).toEqual([
        { error: expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }) },
        { error: expect.objectContaining({ code: 'FORBIDDEN_ERROR', status: 403 }) },
        { error: expect.objectContaining({ code: 'RATE_LIMITED_ERROR', status: 429 }) }
      ]);
    } finally {
      api.events.close();
    }
  });
});

describe('Property 22: public prospect provenance, privacy, and operation parity', () => {
  it('matches UI and WebMCP operation results, audit records, and domain preservation for generated inputs', async () => {
    // Feature: pipelineos, Property 22: Public prospect provenance, privacy, and operation parity
    await fc.assert(
      fc.asyncProperty(
        publicInputArbitrary,
        injectedOutcomeArbitrary,
        authorizedActorArbitrary,
        async (input, outcome, actor) => {
          const uiService = new InjectedPublicProspectService(outcome);
          const webMcpService = new InjectedPublicProspectService(outcome);
          const uiApi = createPublicApi(uiService, actor);
          const webMcpApi = createPublicApi(webMcpService, actor);
          const uiClient = new OperationClient({
            fetcher: directOperationFetcher(uiApi.operationService),
            refreshState: async () => undefined
          });
          const webMcpClient = new OperationClient({
            fetcher: directOperationFetcher(webMcpApi.operationService),
            refreshState: async () => undefined
          });
          const adapter = new CollectingWebMcpAdapter();
          const tools = registerAllTools({
            client: webMcpClient,
            agentContext: actor,
            adapter,
            force: true
          });
          const publicTool = tools.find(
            (tool) => tool.name === PUBLIC_OPERATION
          );

          try {
            expect(tools).toHaveLength(OPERATION_NAMES.length);
            expect(publicTool).toBeDefined();

            const uiResult = await capture(() =>
              uiClient.invoke(PUBLIC_OPERATION, input, actor)
            );
            const webMcpResult = await capture(() =>
              publicTool!.execute(input)
            );

            expect(uiResult).toEqual(webMcpResult);
            expect(uiResult).toEqual({
              ok: outcome === 'success',
              ...(outcome === 'success'
                ? { value: expectedOutcomePayload(outcome, input) }
                : { error: expectedOutcomePayload(outcome, input) })
            });
            expect(uiService.calls).toBe(1);
            expect(webMcpService.calls).toBe(1);

            const uiState = uiApi.repository.read();
            const webMcpState = webMcpApi.repository.read();
            expect(domainCollections(uiState)).toEqual(
              domainCollections(webMcpState)
            );
            expect(domainCollections(uiState)).toEqual(
              domainCollections(createTestContext().repository.read())
            );
            expect(uiState.revision).toBe(1);
            expect(webMcpState.revision).toBe(1);
            expect(uiState.activityLog).toHaveLength(1);
            expect(webMcpState.activityLog).toHaveLength(1);
            expect(uiState.activityLog).toEqual(webMcpState.activityLog);
            expect(uiState.activityLog[0]).toMatchObject({
              toolName: PUBLIC_OPERATION,
              actorType: actor.actorType,
              actorId: actor.actorId,
              input,
              output:
                outcome === 'success'
                  ? expectedOutcomePayload(outcome, input)
                  : expectedOutcomePayload(outcome, input)
            });
            expect(JSON.stringify(uiState.activityLog)).not.toMatch(
              /GITHUB_TOKEN|Authorization|email|phone|resume|contact/iu
            );
          } finally {
            resetWebMcpRegistry();
            uiApi.events.close();
            webMcpApi.events.close();
          }
        }
      ),
      PROPERTY_TEST_OPTIONS
    );
  });
});
