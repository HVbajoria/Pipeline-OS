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
  type VerifiedIdentityClaims,
  type OidcWebClient
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

const RECRUITER_TOKEN = 'tok-recruiter-acme';
const RECRUITER_CLAIMS: VerifiedIdentityClaims = {
  subject: 'sarah-recruiter',
  tenantId: 'tenant-acme',
  roles: ['recruiter'],
  resourceIds: {
    job: ['job-1'],
    candidate: ['cand-1', 'cand-2', 'cand-3'],
    panel: ['panel-1']
  }
};

let activeApi: PipelineApi | undefined;
let activeServer: Server | undefined;

function stubWebClient(claims: VerifiedIdentityClaims): OidcWebClient {
  return {
    authorizationUrl: ({ state, redirectUri }) =>
      `https://idp.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async () => ({ claims })
  };
}

async function startApi(authProvider: AuthProvider): Promise<string> {
  activeApi = createPipelineApi({
    environment: 'production',
    repository: new SharedStateRepository(createSeed()),
    authorizationPolicy: createAuthorizationPolicy({ environment: 'production' }),
    authProvider
  });
  activeServer = createServer(activeApi.app);
  await new Promise<void>((resolve) => activeServer!.listen(0, '127.0.0.1', resolve));
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

const mcpProvider: AuthProvider = {
  mcp: {
    verifier: new StaticClaimsTokenVerifier({
      [RECRUITER_TOKEN]: { claims: RECRUITER_CLAIMS }
    }),
    resourceUrl: 'https://pipelineos.test/mcp',
    authorizationServers: ['https://idp.test'],
    resourceName: 'PipelineOS'
  }
};

function mcpCall(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  };
}

describe('MCP OAuth boundary', () => {
  it('advertises protected-resource metadata', async () => {
    const baseUrl = await startApi(mcpProvider);
    const result = await request(baseUrl, 'GET', '/.well-known/oauth-protected-resource');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      resource: 'https://pipelineos.test/mcp',
      authorization_servers: ['https://idp.test']
    });
  });

  it('rejects an unauthenticated /mcp call with 401 and a WWW-Authenticate challenge', async () => {
    const baseUrl = await startApi(mcpProvider);
    const result = await request(
      baseUrl,
      'POST',
      '/mcp',
      mcpCall('search_candidates', { query: 'backend' })
    );
    expect(result.status).toBe(401);
    const challenge = result.headers['www-authenticate'];
    expect(String(challenge)).toContain('Bearer');
    expect(String(challenge)).toContain('oauth-protected-resource');
  });

  it('accepts a valid bearer token and routes tools/call through the operation service', async () => {
    const baseUrl = await startApi(mcpProvider);
    const result = await request(
      baseUrl,
      'POST',
      '/mcp',
      mcpCall('search_candidates', { query: 'backend' }),
      { authorization: `Bearer ${RECRUITER_TOKEN}` }
    );
    expect(result.status).toBe(200);
    const body = result.body as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(body.result?.isError ?? false).toBe(false);
    // The MCP-originated call is audited under the token's real subject.
    const lastActivity = activeApi!.repository.read().activityLog.at(-1);
    expect(lastActivity).toMatchObject({ actorId: 'sarah-recruiter', toolName: 'search_candidates' });
  });

  it('rejects an invalid bearer token', async () => {
    const baseUrl = await startApi(mcpProvider);
    const result = await request(
      baseUrl,
      'POST',
      '/mcp',
      mcpCall('search_candidates', { query: 'backend' }),
      { authorization: 'Bearer not-a-real-token' }
    );
    expect(result.status).toBe(401);
  });
});

describe('web OIDC session', () => {
  const webProvider: AuthProvider = {
    web: {
      client: stubWebClient(RECRUITER_CLAIMS),
      cookieSecret: 'test-cookie-secret-please-change',
      redirectUri: 'https://pipelineos.test/auth/callback',
      secureCookie: false
    }
  };

  it('redirects to the IdP on login and reports no session before authentication', async () => {
    const baseUrl = await startApi(webProvider);
    const login = await request(baseUrl, 'GET', '/auth/login');
    expect(login.status).toBe(302);
    expect(String(login.headers.location)).toContain('https://idp.test/authorize');

    const session = await request(baseUrl, 'GET', '/auth/session');
    expect(session.body).toMatchObject({ authenticated: false });
  });

  it('opens a session on callback and authorizes state access with it', async () => {
    const baseUrl = await startApi(webProvider);

    // Begin login to obtain a valid state parameter.
    const login = await request(baseUrl, 'GET', '/auth/login');
    const location = new URL(String(login.headers.location));
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await request(
      baseUrl,
      'GET',
      `/auth/callback?code=auth-code&state=${state}`
    );
    expect(callback.status).toBe(302);
    const setCookie = callback.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];

    // The session cookie now authorizes the actor-scoped state projection.
    const state1 = await request(baseUrl, 'GET', '/api/state', undefined, { cookie });
    expect(state1.status).toBe(200);
    const projection = state1.body as { jobs?: unknown[] };
    expect(Array.isArray(projection.jobs)).toBe(true);

    const sessionInfo = await request(baseUrl, 'GET', '/auth/session', undefined, { cookie });
    expect(sessionInfo.body).toMatchObject({
      authenticated: true,
      subject: 'sarah-recruiter',
      tenantId: 'tenant-acme'
    });
  });

  it('fails closed without a session cookie', async () => {
    const baseUrl = await startApi(webProvider);
    const state = await request(baseUrl, 'GET', '/api/state');
    expect(state.status).toBe(403);
  });
});
