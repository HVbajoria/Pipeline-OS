import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPipelineApi, type PipelineApi } from '../src/server/api';

interface HttpResult {
  status: number;
  body: unknown;
}

let activeServer: Server | undefined;
let activeApi: PipelineApi | undefined;

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
        path: url.pathname,
        headers: {
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
            // Preserve non-JSON output so an accidental fallback is visible.
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );
    clientRequest.on('error', reject);
    if (payload !== undefined) clientRequest.write(payload);
    clientRequest.end();
  });
}

async function startProductionApi(): Promise<string> {
  activeApi = createPipelineApi({ environment: 'production' });
  activeServer = createServer(activeApi.app);
  await new Promise<void>((resolve) => {
    activeServer!.listen(0, '127.0.0.1', resolve);
  });
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

describe('production API composition boundary', () => {
  it('fails closed when no trusted host resolver or static principal is supplied', async () => {
    const baseUrl = await startProductionApi();
    const forgedHeaders = {
      'x-actor-type': 'human_ui',
      'x-actor-id': 'sarah-recruiter'
    };

    const state = await request(baseUrl, 'GET', '/api/state', undefined, forgedHeaders);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({
      error: { code: 'FORBIDDEN_ERROR', status: 403 }
    });

    const operation = await request(
      baseUrl,
      'POST',
      '/api/operations/search_candidates',
      { input: {} },
      forgedHeaders
    );
    expect(operation.status).toBe(403);
    expect(operation.body).toMatchObject({
      error: { code: 'FORBIDDEN_ERROR', status: 403 }
    });
    expect(activeApi!.repository.read().activityLog.at(-1)).toMatchObject({
      actorId: 'unauthenticated',
      toolName: 'search_candidates'
    });
  });
});
