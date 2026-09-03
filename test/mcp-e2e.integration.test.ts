import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createPipelineApi, type PipelineApi } from '../src/server/api';
import { createSeed } from '../src/server/seed';
import { SharedStateRepository } from '../src/server/repository';
import { createAuthorizationPolicy } from '../src/server/authorization';
import {
  StaticClaimsTokenVerifier,
  type AuthProvider,
  type OidcWebClient,
  type VerifiedIdentityClaims
} from '../src/server/auth';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const clientRequest = httpRequest(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          accept: 'application/json, text/event-stream',
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
            /* keep raw text */
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed });
        });
      }
    );
    clientRequest.on('error', reject);
    if (payload !== undefined) clientRequest.write(payload);
    clientRequest.end();
  });
}

const TOKEN = 'tok-recruiter-e2e';
const CLAIMS: VerifiedIdentityClaims = {
  subject: 'sarah-recruiter',
  tenantId: 'tenant-acme',
  roles: ['recruiter'],
  resourceIds: {
    job: ['job-1'],
    candidate: ['cand-1', 'cand-2', 'cand-3'],
    panel: ['panel-1']
  }
};

function stubWebClient(claims: VerifiedIdentityClaims): OidcWebClient {
  return {
    authorizationUrl: ({ state, redirectUri }) =>
      `https://idp.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async () => ({ claims })
  };
}

const authProvider: AuthProvider = {
  // MCP OAuth for the agent/ChatGPT surface (bearer token on /mcp).
  mcp: {
    verifier: new StaticClaimsTokenVerifier({ [TOKEN]: { claims: CLAIMS } }),
    resourceUrl: 'https://pipelineos.test/mcp',
    authorizationServers: ['https://idp.test'],
    resourceName: 'PipelineOS'
  },
  // Web OIDC session for the browser/UI-click surface (session cookie on /api).
  web: {
    client: stubWebClient(CLAIMS),
    cookieSecret: 'test-cookie-secret-please-change',
    redirectUri: 'https://pipelineos.test/auth/callback',
    secureCookie: false
  }
};

/** Complete the web OIDC login flow and return the session cookie. */
async function login(baseUrl: string): Promise<string> {
  const start = await request(baseUrl, 'GET', '/auth/login');
  const state = new URL(String(start.headers.location)).searchParams.get('state');
  const callback = await request(
    baseUrl,
    'GET',
    `/auth/callback?code=auth-code&state=${state}`
  );
  const setCookie = callback.headers['set-cookie'];
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
}

let activeApi: PipelineApi | undefined;
let activeServer: Server | undefined;

async function startApi(): Promise<string> {
  activeApi = createPipelineApi({
    // Production trust boundary + real bearer auth: only the token maps to a
    // principal; arbitrary actor headers are ignored.
    environment: 'production',
    repository: new SharedStateRepository(createSeed()),
    authorizationPolicy: createAuthorizationPolicy({ environment: 'production' }),
    authProvider,
    security: { rateLimitDisabled: true }
  });
  activeServer = createServer(activeApi.app);
  await new Promise<void>((resolve) =>
    activeServer!.listen(0, '127.0.0.1', resolve)
  );
  const address = activeServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  activeApi?.events.close();
  activeApi = undefined;
  if (activeServer !== undefined) {
    const server = activeServer;
    activeServer = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

const bearer = { authorization: `Bearer ${TOKEN}` };

const jobArgs = {
  title: 'Staff Platform Engineer',
  department: 'Engineering',
  requirements: ['Go', 'Kubernetes'],
  compBand: { min: 180000, max: 220000, currency: 'USD' }
};

describe('MCP end-to-end over HTTP with a bearer token', () => {
  it('requires a bearer token: tools/list is rejected with 401 when missing', async () => {
    const baseUrl = await startApi();
    const result = await request(baseUrl, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    });
    expect(result.status).toBe(401);
    expect(String(result.headers['www-authenticate'])).toContain('Bearer');
  });

  it('lists all 32 tools through tools/list with a valid bearer token', async () => {
    const baseUrl = await startApi();
    const result = await request(
      baseUrl,
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      bearer
    );
    expect(result.status).toBe(200);
    const body = result.body as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.length).toBe(32);
    expect(body.result?.tools?.map((t) => t.name)).toContain('create_job_requisition');
  });

  it('executes tools/call and produces the same audit entry as the /api (UI-click) path', async () => {
    const baseUrl = await startApi();

    // 1) UI-click path: an authenticated browser user (web OIDC session cookie)
    // posts to the canonical operation endpoint — the exact path a role-view
    // button uses. Same underlying identity (sarah-recruiter) as the token.
    const cookie = await login(baseUrl);
    const uiResult = await request(
      baseUrl,
      'POST',
      '/api/operations/create_job_requisition',
      { input: jobArgs },
      { cookie }
    );
    expect(uiResult.status).toBe(200);
    const uiActivity = activeApi!.repository.read().activityLog.at(-1)!;

    // 2) MCP path: the same operation via tools/call with the same bearer token.
    const mcpResult = await request(
      baseUrl,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'create_job_requisition', arguments: jobArgs }
      },
      bearer
    );
    expect(mcpResult.status).toBe(200);
    const mcpBody = mcpResult.body as { result?: { isError?: boolean } };
    expect(mcpBody.result?.isError ?? false).toBe(false);
    const mcpActivity = activeApi!.repository.read().activityLog.at(-1)!;

    // Both invocations funnel through the same OperationService, so they audit
    // identically: same tool, same trusted actor (from the token), same phase,
    // and the same output shape ({ jobId }). They are distinct entries with
    // distinct generated ids.
    expect(mcpActivity.toolName).toBe(uiActivity.toolName);
    expect(mcpActivity.toolName).toBe('create_job_requisition');
    expect(mcpActivity.actorId).toBe('sarah-recruiter');
    expect(mcpActivity.actorType).toBe(uiActivity.actorType);
    expect(mcpActivity.actorType).toBe('human_ui');
    expect(mcpActivity.phase).toBe(uiActivity.phase);
    expect(Object.keys(mcpActivity.output).sort()).toEqual(
      Object.keys(uiActivity.output).sort()
    );
    expect(mcpActivity.output).toHaveProperty('jobId');
    expect(mcpActivity.id).not.toBe(uiActivity.id);

    // Two requisitions were actually created via the two surfaces.
    const jobs = activeApi!.repository.read().jobs;
    const created = [...jobs.values()].filter(
      (job) => job.title === jobArgs.title
    );
    expect(created).toHaveLength(2);
  });

  it('rejects an invalid bearer token on tools/call', async () => {
    const baseUrl = await startApi();
    const result = await request(
      baseUrl,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'search_candidates', arguments: { query: 'x' } }
      },
      { authorization: 'Bearer not-a-real-token' }
    );
    expect(result.status).toBe(401);
  });
});
