/**
 * The single server-side execution boundary for PipelineOS operations.
 *
 * Operation handlers receive an isolated state snapshot (a transaction draft
 * for mutations) and injected deterministic dependencies. They never receive
 * the repository, client store, Express request, or WebMCP runtime, which
 * keeps all adapters on the same validation, mutation, and audit path.
 */

import type {
  ActivityLogEntry,
  ActorContext,
  JsonObject,
  SharedStateWithCatalogs,
  Timestamp
} from '../shared/models';
import type {
  OperationInput,
  OperationInputMap,
  OperationName,
  OperationOutput,
  OperationOutputMap
} from '../shared/operations';
import {
  getOperationDescriptor
} from '../shared/operations';
import {
  InternalError,
  PipelineError,
  type PipelineErrorPayload,
  serializePipelineErrorObject
} from '../shared/errors';
import {
  assertActorContext,
  assertOperationName,
  isPlainObject,
  validateOperationInput,
  validateOperationOutput
} from '../shared/validators';
import {
  deepClone,
  SharedStateRepository,
  type Clock,
  type IdGenerator
} from './repository';

/**
 * Context supplied to an operation implementation. `state` is always an
 * isolated object: for a mutation it is the repository transaction draft, and
 * for a read it is a disposable snapshot. No client-side state or repository
 * mutator is exposed to handlers.
 */
export interface OperationHandlerContext<
  N extends OperationName = OperationName
> {
  readonly operationName: N;
  readonly actor: ActorContext;
  readonly state: SharedStateWithCatalogs;
  readonly readOnly: boolean;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  now(): Timestamp;
  nextId(prefix?: string): string;
}

/** A server operation implementation, injectable by phase-specific modules. */
export type OperationHandler<N extends OperationName = OperationName> = (
  input: OperationInputMap[N],
  context: OperationHandlerContext<N>
) => OperationOutputMap[N] | PromiseLike<OperationOutputMap[N]>;

/**
 * Partial registry deliberately allows later phase modules to register their
 * own handler without editing a central dispatcher map.
 */
export type OperationHandlerMap = Partial<{
  [N in OperationName]: OperationHandler<N>;
}>;

export interface OperationServiceOptions {
  repository?: SharedStateRepository;
  handlers?: OperationHandlerMap;
}

function isRepository(value: unknown): value is SharedStateRepository {
  return (
    value instanceof SharedStateRepository ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as Partial<SharedStateRepository>).read === 'function' &&
      typeof (value as Partial<SharedStateRepository>).appendActivity ===
        'function' &&
      typeof (value as Partial<SharedStateRepository>).transactAsync ===
        'function')
  );
}

function toJsonSafe(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch {
    return '[unserializable value]';
  }
}

/** Activity input is an object by contract, even when a malformed invocation supplies another value. */
function activityInput(value: unknown): JsonObject {
  if (isPlainObject(value)) {
    return deepClone(value) as JsonObject;
  }

  return { value: toJsonSafe(value) as JsonObject['value'] };
}

function activityActor(value: unknown): ActorContext {
  if (isPlainObject(value)) {
    const actorType = value.actorType;
    const actorId = value.actorId;
    if (
      (actorType === 'human_ui' || actorType === 'agent') &&
      typeof actorId === 'string' &&
      actorId.trim().length > 0
    ) {
      return { actorType, actorId };
    }
  }

  // Invalid actor metadata cannot satisfy the normative actor enum. Keep the
  // failed invocation auditable with a deterministic safe actor instead of
  // dropping the error audit entry altogether.
  return { actorType: 'human_ui', actorId: 'unknown-actor' };
}

function operationNameForActivity(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown_operation';
}

function asPipelineError(error: unknown): PipelineError {
  if (error instanceof PipelineError) return error;
  return new InternalError('Internal server error');
}

/** Serialize and contract-check an operation output before it can be committed. */
function serializeOutput<N extends OperationName>(
  name: N,
  output: unknown
): OperationOutputMap[N] {
  const validated = validateOperationOutput(name, output);

  try {
    const encoded = JSON.stringify(validated);
    if (encoded === undefined) {
      throw new Error('output is not JSON serializable');
    }
    return JSON.parse(encoded) as OperationOutputMap[N];
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new InternalError(`Operation ${name} produced an invalid output`);
  }
}

/** Build the one persisted activity entry for a completed invocation. */
function createActivityEntry(
  repository: SharedStateRepository,
  name: string,
  actor: ActorContext,
  input: JsonObject,
  output: JsonObject
): ActivityLogEntry {
  return {
    id: repository.nextId('activity'),
    toolName: name,
    actorType: actor.actorType,
    actorId: actor.actorId,
    input: deepClone(input),
    output: deepClone(output),
    timestamp: repository.now()
  };
}

/**
 * Shared operation dispatcher used by both UI and WebMCP adapters.
 */
export class OperationService {
  readonly repository: SharedStateRepository;
  private readonly handlers = new Map<OperationName, OperationHandler>();

  constructor(
    repositoryOrOptions: SharedStateRepository | OperationServiceOptions = {},
    initialHandlers: OperationHandlerMap = {}
  ) {
    if (isRepository(repositoryOrOptions)) {
      this.repository = repositoryOrOptions;
      this.registerHandlers(initialHandlers);
      return;
    }

    this.repository = repositoryOrOptions.repository ?? new SharedStateRepository();
    this.registerHandlers({
      ...(repositoryOrOptions.handlers ?? {}),
      ...initialHandlers
    });
  }

  /** Add one phase-specific handler without changing the shared dispatcher. */
  registerHandler<N extends OperationName>(
    name: N,
    handler: OperationHandler<N>
  ): void {
    assertOperationName(name);
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for ${name} must be a function`);
    }
    this.handlers.set(name, handler as OperationHandler);
  }

  /** Register any subset of the canonical operation handlers. */
  registerHandlers(handlers: OperationHandlerMap): void {
    for (const [name, handler] of Object.entries(handlers) as Array<[
      OperationName,
      OperationHandler | undefined
    ]>) {
      if (handler !== undefined) {
        this.registerHandler(name, handler);
      }
    }
  }

  hasHandler(name: OperationName): boolean {
    return this.handlers.has(name);
  }

  getHandler<N extends OperationName>(name: N): OperationHandler<N> | undefined {
    return this.handlers.get(name) as OperationHandler<N> | undefined;
  }

  /**
   * Validate, execute, serialize, audit, and return one canonical operation.
   * Failed mutations never commit their drafts; the failure audit is appended
   * in one audit-only revision.
   */
  async invoke<N extends OperationName>(
    name: N,
    input: OperationInput<N>,
    actor: ActorContext
  ): Promise<OperationOutput<N>> {
    const auditName = operationNameForActivity(name);
    const auditActor = activityActor(actor);
    const originalInput = activityInput(input);

    try {
      assertOperationName(name);
      const validatedActor = assertActorContext(actor);
      const validatedInput = validateOperationInput(name, input);
      const descriptor = getOperationDescriptor(name);
      const handler = this.handlers.get(name);

      if (handler === undefined) {
        throw new InternalError(`Operation handler is not configured: ${name}`, {
          field: 'operationName'
        });
      }

      if (descriptor.readOnly) {
        const snapshot = this.repository.read();
        const rawOutput = await handler(
          deepClone(validatedInput),
          this.createHandlerContext(name, validatedActor, snapshot, true)
        );
        const output = serializeOutput(name, rawOutput);
        const activity = createActivityEntry(
          this.repository,
          name,
          validatedActor,
          activityInput(validatedInput),
          output as unknown as JsonObject
        );
        this.repository.appendActivity(activity);
        return output as OperationOutput<N>;
      }

      const output = await this.repository.transactAsync(async (draft) => {
        const rawOutput = await handler(
          deepClone(validatedInput),
          this.createHandlerContext(name, validatedActor, draft, false)
        );
        const serializedOutput = serializeOutput(name, rawOutput);
        const activity = createActivityEntry(
          this.repository,
          name,
          validatedActor,
          activityInput(validatedInput),
          serializedOutput as unknown as JsonObject
        );
        draft.activityLog.push(activity);
        return serializedOutput;
      });

      return output as OperationOutput<N>;
    } catch (error) {
      const pipelineError = asPipelineError(error);
      this.appendFailure(
        auditName,
        auditActor,
        originalInput,
        pipelineError
      );
      throw pipelineError;
    }
  }

  private createHandlerContext<N extends OperationName>(
    name: N,
    actor: ActorContext,
    state: SharedStateWithCatalogs,
    readOnly: boolean
  ): OperationHandlerContext<N> {
    return {
      operationName: name,
      actor: deepClone(actor),
      state,
      readOnly,
      clock: this.repository.clock,
      idGenerator: this.repository.idGenerator,
      now: () => this.repository.now(),
      nextId: (prefix?: string) => this.repository.nextId(prefix)
    };
  }

  private appendFailure(
    name: string,
    actor: ActorContext,
    input: JsonObject,
    error: PipelineError
  ): void {
    const output: PipelineErrorPayload = error.toPayload();
    const activity = createActivityEntry(
      this.repository,
      name,
      actor,
      input,
      output as unknown as JsonObject
    );
    this.repository.appendActivity(activity);
  }
}

export function createOperationService(
  options: OperationServiceOptions = {}
): OperationService {
  return new OperationService(options);
}

export const SharedOperationService = OperationService;
export type SharedOperationHandler<N extends OperationName = OperationName> =
  OperationHandler<N>;
export type SharedOperationHandlerMap = OperationHandlerMap;

/** Convenience helper for adapters that need a serializable error object. */
export function operationErrorObject(error: unknown) {
  return serializePipelineErrorObject(error);
}

// Keep this type import available for consumers that use this module as their
// server-side contract entry point without creating a runtime dependency.
export type { OperationInputMap, OperationName, OperationOutputMap };
