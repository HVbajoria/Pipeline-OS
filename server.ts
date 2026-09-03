// Load environment variables from a local .env file before anything reads
// process.env (Firestore credentials, PERSISTENCE_BACKEND, auth config, etc.).
// This is a no-op when no .env file is present.
import 'dotenv/config';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { Express } from 'express';
import {
  createPipelineApi,
  type PipelineApi,
  type PipelineApiOptions
} from './src/server/api';
import { OperationService } from './src/server/operationService';
import {
  approvalOperationAdapters,
  defaultOperationHandlers
} from './src/server/operations';
import { SharedStateRepository } from './src/server/repository';
import { createSeed } from './src/server/seed';
import { StateEventPublisher } from './src/server/events';
import { PublicJobsCoordinator } from './src/server/imports/publicJobs';
import {
  createAuthorizationPolicy,
  createTrustedActorResolver,
  type AuthorizationEnvironment,
  type AuthorizationPolicy,
  type ProductionTrustedPrincipalResolver,
  type TrustedActorResolver
} from './src/server/authorization';
import {
  firebaseAuthOptionsFromEnv,
  type AuthProvider
} from './src/server/auth';
import {
  createDurablePersistence,
  durablePersistenceAvailable,
  type DurablePersistence
} from './src/server/persistence';
import { getLogger } from './src/server/observability/logger';
import {
  startMaintenanceScheduler,
  type MaintenanceHandle
} from './src/server/maintenance';

export interface ServerOptions extends PipelineApiOptions {
  port?: number;
  host?: string;
  /** Explicit environment override for demo/test versus production trust. */
  environment?: AuthorizationEnvironment;
  /** Injectable trusted identity seam used by an embedding host. */
  trustedActorResolver?: TrustedActorResolver;
  /** Injectable centralized policy; handlers never construct their own. */
  authorizationPolicy?: AuthorizationPolicy;
  /** Production host callback; arbitrary actor headers are never used here. */
  resolveTrustedPrincipal?: ProductionTrustedPrincipalResolver;
  /** Real auth provider (web OIDC session and/or MCP OAuth bearer). */
  authProvider?: AuthProvider;
}

export interface ServerComposition {
  app: Express;
  api: PipelineApi;
  environment: AuthorizationEnvironment;
  trustedActorResolver: TrustedActorResolver;
  authorizationPolicy: AuthorizationPolicy;
  /** Present only when durable Firestore persistence is active. */
  durablePersistence?: DurablePersistence;
}

/**
 * Compose the API with Vite/static serving. Business behavior lives in the
 * shared API/service modules; this file only owns process composition.
 */
export async function createServerApp(
  options: ServerOptions = {}
): Promise<ServerComposition> {
  const environment: AuthorizationEnvironment =
    options.environment ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  // Resolve identity and policy once at the composition root.  The production
  // resolver is intentionally fail-closed when no host callback is supplied;
  // the legacy API remains injectable for existing non-production callers.
  const trustedActorResolver =
    options.trustedActorResolver ??
    createTrustedActorResolver({
      environment,
      resolvePrincipal: options.resolveTrustedPrincipal
    });
  const authorizationPolicy =
    options.authorizationPolicy ?? createAuthorizationPolicy({ environment });

  // Durable persistence: when Firestore is configured (credentials present and
  // not explicitly disabled), replace the in-memory repository, idempotency
  // ledger, and web session store with Firestore-backed equivalents so state
  // survives restarts and is shared across instances. When it is unavailable,
  // the deterministic in-memory demo stores are used exactly as before.
  let durablePersistence: DurablePersistence | undefined;
  if (
    options.repository === undefined &&
    options.operationService === undefined &&
    durablePersistenceAvailable()
  ) {
    try {
      durablePersistence = await createDurablePersistence({
        onError: (error, context) =>
          getLogger().error(
            { err: error, store: context.store, operation: context.operation },
            'persistence write failed'
          )
      });
      getLogger().info('durable persistence enabled (Firestore)');
    } catch (error) {
      getLogger().warn(
        { err: error },
        'Firestore persistence unavailable; falling back to in-memory state'
      );
    }
  }

  // Keep every mutable dependency in this composition root. The API factory
  // remains injectable for tests, but the running server explicitly owns the
  // deterministic seed, complete operation registry, service, and publisher.
  const repository =
    options.operationService?.repository ??
    options.repository ??
    durablePersistence?.repository ??
    new SharedStateRepository(createSeed());
  const operationService =
    options.operationService ??
    new OperationService({
      repository,
      handlers: {
        ...defaultOperationHandlers,
        ...(options.handlers ?? {})
      },
      orchestrationAdapters: approvalOperationAdapters,
      authorizationPolicy,
      environment,
      principal: options.principal,
      trustedPrincipal: options.trustedPrincipal,
      principalResolver: options.principalResolver,
      resolvePrincipal: options.resolvePrincipal,
      idempotencyTtlMs: options.idempotencyTtlMs,
      approvalTtlMs: options.approvalTtlMs,
      traceIdentifiers: options.traceIdentifiers
    });
  // Compose Firebase Authentication from environment when no host-specific
  // provider was injected. Production stays fail-closed unless this is
  // explicitly enabled with a server-side Admin SDK credential and session
  // secret.
  let authProvider = options.authProvider;
  if (authProvider === undefined) {
    const firebase = firebaseAuthOptionsFromEnv();
    if (firebase !== undefined) authProvider = { firebase };
  }
  // When durable persistence is active and a browser auth provider is
  // configured, back its session store with Firestore (unless the caller
  // already supplied one) so sessions survive restarts and work across
  // instances.
  if (
    durablePersistence !== undefined &&
    authProvider?.web !== undefined &&
    authProvider.web.store === undefined
  ) {
    authProvider = {
      ...authProvider,
      web: { ...authProvider.web, store: durablePersistence.sessionStore }
    };
  }
  if (
    durablePersistence !== undefined &&
    authProvider?.firebase !== undefined &&
    authProvider.firebase.store === undefined
  ) {
    authProvider = {
      ...authProvider,
      firebase: { ...authProvider.firebase, store: durablePersistence.sessionStore }
    };
  }

  const eventPublisher =
    options.eventPublisher ?? new StateEventPublisher(operationService.repository);
  const publicJobs =
    options.publicJobs ?? new PublicJobsCoordinator(options.publicJobsOptions);
  const apiOptions: PipelineApiOptions = {
    repository: operationService.repository,
    operationService,
    eventPublisher,
    publicJobs,
    trustedActorResolver,
    authorizationPolicy,
    environment,
    githubProspects: options.githubProspects,
    githubProspectAuthorization: options.githubProspectAuthorization,
    githubProspectsOptions: options.githubProspectsOptions,
    stateProjectionHooks: options.stateProjectionHooks,
    stateProjection: options.stateProjection,
    ...(authProvider === undefined ? {} : { authProvider })
  };

  // An injected service may still receive test/extension handlers, while the
  // normal composition path above has already registered the complete handler registry.
  if (options.operationService && options.handlers) {
    apiOptions.handlers = options.handlers;
  }

  const api = createPipelineApi(apiOptions);

  // The API factory installs WebMCP eligibility headers before this branch,
  // so both Vite HTML and production static HTML inherit the same policy.
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    api.app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    api.app.use((await import('express')).default.static(distPath));
    // Express 5 requires a named wildcard parameter; the brace form also
    // matches the root path so the SPA fallback covers `/` and nested routes.
    api.app.get('/{*splat}', (_request, response) => {
      response.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return {
    app: api.app,
    api,
    environment,
    trustedActorResolver,
    authorizationPolicy,
    durablePersistence
  };
}

export async function startServer(options: ServerOptions = {}) {
  const {
    app,
    api,
    environment,
    trustedActorResolver,
    authorizationPolicy,
    durablePersistence
  } = await createServerApp(options);
  // Cloud Run (and most container platforms) inject the listen port via PORT
  // and require binding all interfaces. Explicit options still win for tests.
  const envPort = Number(process.env.PORT);
  const port =
    options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 3000);
  const host =
    options.host ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost');
  const logger = getLogger();

  // Scheduled cleanup for approval-card and ledger TTLs (and public-prospect
  // retention). Without this, expired records only transition lazily on access
  // and would accumulate in a long-running durable store.
  const maintenance: MaintenanceHandle = startMaintenanceScheduler({
    repository: api.repository
  });

  const server = app.listen(port, host, () => {
    logger.info({ host, port, environment }, 'server started');
  });

  const close = async (): Promise<void> => {
    maintenance.stop();
    api.events.close();
    durablePersistence?.repository.stopRemoteSync();
    await durablePersistence?.repository.flush().catch(() => undefined);
    await durablePersistence?.ledger.flush().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    api,
    environment,
    trustedActorResolver,
    authorizationPolicy,
    maintenance,
    close
  };
}

function isEntrypoint(): boolean {
  const script = process.argv[1] ?? '';
  return /(?:^|[\\/])server\.(?:ts|js|cjs|mjs)$/.test(script);
}

if (isEntrypoint()) {
  void startServer()
    .then(({ close }) => {
      const logger = getLogger();
      const shutdown = (signal: string) => {
        logger.info({ signal }, 'shutting down gracefully');
        void close()
          .then(() => process.exit(0))
          .catch((error) => {
            logger.error({ err: error }, 'error during shutdown');
            process.exit(1);
          });
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error) => {
      getLogger().error({ err: error }, 'failed to start server');
      process.exitCode = 1;
    });
}
