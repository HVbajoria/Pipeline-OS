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
import { MetricsRegistry } from '../src/server/observability/metrics';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  raw: string;
}

function request(baseUrl: string, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const clientRequest = httpRequest(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { accept: '*/*' }
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          try {
            parsed = raw.length === 0 ? undefined : JSON.parse(raw);
          } catch {
            /* keep raw text */
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsed,
            raw
          });
        });
      }
    );
    clientRequest.on('error', reject);
    clientRequest.end();
  });
}

let activeApi: PipelineApi | undefined;
let activeServer: Server | undefined;

async function startApi(metrics: MetricsRegistry): Promise<string> {
  activeApi = createPipelineApi({
    repository: new SharedStateRepository(createSeed()),
    enableMcpEndpoint: false,
    metrics,
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

describe('observability endpoints', () => {
  it('serves /health (liveness)', async () => {
    const baseUrl = await startApi(new MetricsRegistry());
    const result = await request(baseUrl, '/health');
    expect(result.status).toBe(200);
    expect((result.body as { status?: string }).status).toBe('ok');
  });

  it('serves /ready (readiness) with the current revision', async () => {
    const baseUrl = await startApi(new MetricsRegistry());
    const result = await request(baseUrl, '/ready');
    expect(result.status).toBe(200);
    const body = result.body as { status?: string; revision?: number };
    expect(body.status).toBe('ready');
    expect(typeof body.revision).toBe('number');
  });

  it('serves /metrics in Prometheus text format', async () => {
    const metrics = new MetricsRegistry();
    metrics.recordMcpToolCall('search_candidates', 'success');
    const baseUrl = await startApi(metrics);

    const result = await request(baseUrl, '/metrics');
    expect(result.status).toBe(200);
    expect(String(result.headers['content-type'])).toContain('text/plain');
    expect(result.raw).toContain('# TYPE pipelineos_operations_total counter');
    expect(result.raw).toContain('pipelineos_mcp_tool_calls_total');
    expect(result.raw).toContain('pipelineos_process_uptime_seconds');
  });
});
