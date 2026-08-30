/** Express boundary for canonical operations and legacy compatibility aliases. */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response
} from 'express';
import type {
  ActivityLogEntry,
  SharedStateProjectionWithCatalogs,
  SharedStateWithCatalogs
} from '../shared/models';
import {
  PipelineError,
  ValidationError
} from '../shared/errors';
import {
  type OperationName,
  OPERATION_NAMES
} from '../shared/operations';
import { isPlainObject } from '../shared/validators';
import { deepClone, SharedStateRepository } from './repository';
import {
  OperationService,
  type OperationHandlerMap,
  type OperationServiceOptions
} from './operationService';
import {
  StateEventPublisher,
  serializeStateChangedEvent
} from './events';
import { resolveActorContext } from './actorContext';
import { defaultOperationHandlers } from './operations';

export interface PipelineApiOptions extends OperationServiceOptions {
  operationService?: OperationService;
  eventPublisher?: StateEventPublisher;
}

export interface PipelineApi {
  app: Express;
  repository: SharedStateRepository;
  operationService: OperationService;
  events: StateEventPublisher;
}

function mapValues<T>(collection: Map<string, T>): T[] {
  return [...collection.values()].map((value) => deepClone(value));
}

/** Convert the map-backed repository snapshot to the stable JSON state shape. */
export function serializeSharedState(
  state: SharedStateWithCatalogs
): SharedStateProjectionWithCatalogs {
  return {
    revision: state.revision,
    jobs: mapValues(state.jobs),
    candidates: mapValues(state.candidates),
    applications: mapValues(state.applications),
    panels: mapValues(state.panels),
    interviews: mapValues(state.interviews),
    scorecards: mapValues(state.scorecards),
    offers: mapValues(state.offers),
    onboardingTasks: mapValues(state.onboardingTasks),
    backgroundChecks: mapValues(state.backgroundChecks),
    benefitsEnrollments: mapValues(state.benefitsEnrollments),
    activityLog: deepClone(state.activityLog) as ActivityLogEntry[],
    catalogs: {
      availabilityCalendar: [...state.catalogs.availabilityCalendar.entries()].map(
        ([interviewerId, freeSlots]) => ({
          interviewerId,
          freeSlots: deepClone(freeSlots)
        })
      ),
      roleTemplates: deepClone(state.catalogs.roleTemplates),
      planCatalog: deepClone(state.catalogs.planCatalog),
      startDate: state.catalogs.startDate
    }
  };
}

function sendError(response: Response, error: unknown): void {
  const pipelineError = PipelineError.from(error);
  if (!response.headersSent) {
    response.status(pipelineError.status).json(pipelineError.toPayload());
  }
}

function requestBodyInput(request: Request): unknown {
  if (isPlainObject(request.body) && 'input' in request.body) {
    return request.body.input;
  }
  // The canonical endpoint requires `{ input: ... }`; undefined is passed to
  // the shared validator so the invocation still receives one audit entry.
  return undefined;
}

function bodyOrEmpty(request: Request): Record<string, unknown> {
  return isPlainObject(request.body) ? request.body : {};
}

function legacyOfferDecision(value: unknown): unknown {
  if (value === 'accepted') return 'accept';
  if (value === 'declined') return 'decline';
  if (value === 'countered') return 'counter';
  return value;
}

function operationRoute(
  service: OperationService,
  name: OperationName | string,
  input: (request: Request) => unknown
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const actor = resolveActorContext(request);
      const output = await service.invoke(
        name as OperationName,
        input(request) as never,
        actor
      );
      response.json(output);
    } catch (error) {
      if (response.headersSent) {
        next(error);
      } else {
        sendError(response, error);
      }
    }
  };
}

function installCompatibilityRoutes(
  app: Express,
  service: OperationService
): void {
  // Phase A aliases.
  app.post(
    '/api/jobs',
    operationRoute(service, 'create_job_requisition', (request) => request.body)
  );
  app.post(
    '/api/candidates/search',
    operationRoute(service, 'search_candidates', (request) => request.body)
  );
  app.get(
    '/api/candidates/:id',
    operationRoute(service, 'get_candidate_profile', (request) => ({
      candidateId: request.params.id
    }))
  );
  app.post(
    '/api/applications',
    operationRoute(service, 'submit_application', (request) => request.body)
  );
  app.post(
    '/api/applications/:id/screen',
    operationRoute(service, 'screen_candidate', (request) => ({
      applicationId: request.params.id
    }))
  );
  app.post(
    '/api/jobs/:id/faq',
    operationRoute(service, 'answer_candidate_faq', (request) => ({
      jobId: request.params.id,
      question: bodyOrEmpty(request).question
    }))
  );

  // Phase B aliases.
  app.post(
    '/api/interviews/availability',
    operationRoute(service, 'check_interviewer_availability', (request) =>
      request.body
    )
  );
  app.post(
    '/api/interviews/propose',
    operationRoute(service, 'propose_interview_slots', (request) => request.body)
  );
  app.post(
    '/api/interviews/book',
    operationRoute(service, 'book_interview', (request) => request.body)
  );
  app.post(
    '/api/interviews/schedule',
    operationRoute(service, 'book_interview', (request) => request.body)
  );
  app.get(
    '/api/jobs/:id/interview-kit',
    operationRoute(service, 'get_interview_kit', (request) => ({
      jobId: request.params.id
    }))
  );
  app.post(
    '/api/interviews/:id/feedback',
    operationRoute(service, 'submit_interview_feedback', (request) => {
      const body = bodyOrEmpty(request);
      return {
        interviewId: request.params.id,
        interviewer: body.interviewer,
        competencyScores: body.competencyScores,
        recommendation: body.recommendation,
        comments: body.comments
      };
    })
  );
  app.get(
    '/api/applications/:id/feedback-summary',
    operationRoute(service, 'get_panel_feedback_summary', (request) => ({
      applicationId: request.params.id
    }))
  );

  // Phase C aliases. These adapters only translate paths and legacy decision
  // spellings; all validation and mutation remains in OperationService.
  app.post(
    '/api/offers',
    operationRoute(service, 'generate_offer', (request) => request.body)
  );
  app.post(
    '/api/offers/:id/send',
    operationRoute(service, 'send_offer', (request) => ({
      offerId: request.params.id
    }))
  );
  app.post(
    '/api/offers/:id/respond',
    operationRoute(service, 'respond_to_offer', (request) => {
      const body = bodyOrEmpty(request);
      const decision = legacyOfferDecision(body.decision);
      return {
        offerId: request.params.id,
        decision,
        ...(body.counterAmount !== undefined
          ? { counterAmount: body.counterAmount }
          : {})
      };
    })
  );
  app.post(
    '/api/offers/:id/background-check',
    operationRoute(service, 'initiate_background_check', (request) => ({
      offerId: request.params.id
    }))
  );
  app.post(
    '/api/offers/:id/benefits',
    operationRoute(service, 'enroll_benefits', (request) => {
      const body = bodyOrEmpty(request);
      return {
        offerId: request.params.id,
        planSelections: body.planSelections ?? body
      };
    })
  );
  app.post(
    '/api/offers/:id/onboarding',
    operationRoute(service, 'generate_onboarding_checklist', (request) => ({
      offerId: request.params.id
    }))
  );
  app.get(
    '/api/offers/:id/onboarding',
    operationRoute(service, 'get_onboarding_status', (request) => ({
      offerId: request.params.id
    }))
  );
}

/** Create the API plus its dependencies for tests or a composition root. */
export function createPipelineApi(options: PipelineApiOptions = {}): PipelineApi {
  const operationService =
    options.operationService ??
    new OperationService({
      repository: options.repository ?? new SharedStateRepository(),
      handlers: {
        ...defaultOperationHandlers,
        ...(options.handlers ?? {})
      }
    });

  if (options.operationService && options.handlers) {
    operationService.registerHandlers(options.handlers);
  }

  const repository = operationService.repository;
  const events =
    options.eventPublisher ?? new StateEventPublisher(repository);
  const app = express();

  app.use(express.json());

  const canonicalRoute = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    try {
      const actor = resolveActorContext(request);
      const output = await operationService.invoke(
        request.params.operationName as OperationName,
        requestBodyInput(request) as never,
        actor
      );
      response.json(output);
    } catch (error) {
      if (response.headersSent) next(error);
      else sendError(response, error);
    }
  };

  app.post('/api/operations/:operationName', canonicalRoute);

  app.get('/api/state', (_request, response) => {
    response.json(serializeSharedState(repository.read()));
  });

  app.post('/api/reset', (_request, response) => {
    const snapshot = repository.reset();
    response.json({ success: true, revision: snapshot.revision });
  });

  app.get('/api/events', (request, response) => {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();

    let closed = false;
    const unsubscribe = events.subscribe((event) => {
      if (!closed && !response.writableEnded) {
        response.write(serializeStateChangedEvent(event));
      }
    });

    // Send only the current revision as the initial synchronization hint.
    response.write(
      serializeStateChangedEvent({
        type: 'state_changed',
        revision: repository.getRevision()
      })
    );

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
  });

  installCompatibilityRoutes(app, operationService);

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (
      isPlainObject(error) &&
      error.type === 'entity.parse.failed'
    ) {
      sendError(response, new ValidationError('Invalid JSON request body'));
      return;
    }
    sendError(response, error);
  });

  return { app, repository, operationService, events };
}

/** Return only the Express app for conventional HTTP test/server usage. */
export function createApi(options: PipelineApiOptions = {}): Express {
  return createPipelineApi(options).app;
}

export const createExpressApi = createApi;
export const createApplicationApi = createPipelineApi;
export const CANONICAL_OPERATION_NAMES = OPERATION_NAMES;

// Keep the map type visible to callers that build a composition root here.
export type { OperationHandlerMap };
