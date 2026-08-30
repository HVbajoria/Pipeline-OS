import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { Express } from 'express';
import {
  createPipelineApi,
  type PipelineApi,
  type PipelineApiOptions
} from './src/server/api';
import { OperationService } from './src/server/operationService';
import { defaultOperationHandlers } from './src/server/operations';
import { SharedStateRepository } from './src/server/repository';
import { createSeed } from './src/server/seed';
import { StateEventPublisher } from './src/server/events';

export interface ServerOptions extends PipelineApiOptions {
  port?: number;
  host?: string;
}

/**
 * Compose the API with Vite/static serving. Business behavior lives in the
 * shared API/service modules; this file only owns process composition.
 */
export async function createServerApp(
  options: ServerOptions = {}
): Promise<{ app: Express; api: PipelineApi }> {
  // Keep every mutable dependency in this composition root. The API factory
  // remains injectable for tests, but the running server explicitly owns the
  // deterministic seed, complete operation registry, service, and publisher.
  const repository =
    options.operationService?.repository ??
    options.repository ??
    new SharedStateRepository(createSeed());
  const operationService =
    options.operationService ??
    new OperationService({
      repository,
      handlers: {
        ...defaultOperationHandlers,
        ...(options.handlers ?? {})
      }
    });
  const eventPublisher =
    options.eventPublisher ?? new StateEventPublisher(operationService.repository);
  const apiOptions: PipelineApiOptions = {
    repository: operationService.repository,
    operationService,
    eventPublisher
  };

  // An injected service may still receive test/extension handlers, while the
  // normal composition path above has already registered all 19 handlers.
  if (options.operationService && options.handlers) {
    apiOptions.handlers = options.handlers;
  }

  const api = createPipelineApi(apiOptions);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    api.app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    api.app.use((await import('express')).default.static(distPath));
    api.app.get('*', (_request, response) => {
      response.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return { app: api.app, api };
}

export async function startServer(options: ServerOptions = {}) {
  const { app, api } = await createServerApp(options);
  const port = options.port ?? 3000;
  const host = options.host ?? '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}`);
  });

  return { server, api };
}

function isEntrypoint(): boolean {
  const script = process.argv[1] ?? '';
  return /(?:^|[\\/])server\\.(?:ts|js|cjs|mjs)$/.test(script);
}

if (isEntrypoint()) {
  void startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
