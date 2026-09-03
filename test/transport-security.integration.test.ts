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
            /* keep raw text */
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsed
          });
        });
      }
    );
    clientRequest.on('error', reject);
    if (payload !== undefined) clientRequest.write(payload);
    clientRequest.end();
  });
}

let activeApi: PipelineApi | undefined;
let activeServer: Server | undefined;

async function startApi(
  security: NonNullable<Parameters<typeof createPipelineApi>[0]>['security']
): Promise<string> {
  activeApi = createPipelineApi({
    repository: new SharedStateRepository(createSeed()),
    enableMcpEndpoint: false,
    security
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

describe('transport security hardening', () => {
  it('sets security headers (helmet) and preserves WebMCP eligibility headers', async () => {
    const baseUrl = await startApi({ rateLimitDisabled: true });
    const result = await request(baseUrl, 'GET', '/api/state', undefined, {
      'x-actor-type': 'human_ui',
      'x-actor-id': 'sarah-recruiter'
    });

    // helmet defaults
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['x-dns-prefetch-control']).toBeDefined();
    // helmet removes the framework fingerprint
    expect(result.headers['x-powered-by']).toBeUndefined();
    // existing WebMCP eligibility headers remain
    expect(result.headers['origin-agent-cluster']).toBe('?1');
    expect(result.headers['permissions-policy']).toBe('tools=(self)');
  });

  it('rate limits per key once the window budget is exceeded', async () => {
    const baseUrl = await startApi({
      rateLimitWindowMs: 60_000,
      rateLimitMax: 3
    });

    const headers = {
      'x-actor-type': 'human_ui',
      'x-actor-id': 'sarah-recruiter'
    };

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await request(baseUrl, 'GET', '/api/state', undefined, headers);
      statuses.push(result.status);
    }

    // First few within budget, then a 429 with the structured error payload.
    expect(statuses.slice(0, 3).every((status) => status === 200)).toBe(true);
    expect(statuses).toContain(429);

    const limited = await request(baseUrl, 'GET', '/api/state', undefined, headers);
    expect(limited.status).toBe(429);
    expect((limited.body as { error?: { code?: string } }).error?.code).toBe(
      'RATE_LIMITED_ERROR'
    );
  });
});
