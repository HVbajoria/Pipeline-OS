import * as fc from 'fast-check';
import type {
  IAsyncProperty,
  IProperty,
  Parameters as FastCheckParameters
} from 'fast-check';
import type { ActorContext, Timestamp } from '../src/shared/models';
import {
  deepClone,
  SharedStateRepository,
  type Clock,
  type IdGenerator,
  type RepositorySeed
} from '../src/server/repository';
import { createSeed } from '../src/server/seed';

/** Stable timestamp used by deterministic tests unless a fixture overrides it. */
export const TEST_TIMESTAMP: Timestamp = '2026-01-01T00:00:00.000Z';

/** Every numbered property test must execute at least this many cases. */
export const PROPERTY_RUNS = 100;

/** Shared fast-check options keep the minimum run count in one place. */
export const PROPERTY_TEST_OPTIONS = {
  numRuns: PROPERTY_RUNS
} satisfies FastCheckParameters;

/** Fixed clock for tests that must not depend on wall-clock time. */
export class FixedClock implements Clock {
  constructor(private readonly timestamp: Timestamp = TEST_TIMESTAMP) {}

  now(): Timestamp {
    return this.timestamp;
  }
}

/** Sequential, reproducible identifier source for repository fixtures. */
export class DeterministicIdGenerator implements IdGenerator {
  private nextValue: number;

  constructor(
    private readonly defaultPrefix = 'test-id',
    initialValue = 1
  ) {
    this.nextValue = initialValue;
  }

  next(prefix?: string): string {
    const value = `${prefix ?? this.defaultPrefix}-${this.nextValue}`;
    this.nextValue += 1;
    return value;
  }

  /** Reset the sequence when a test reuses the same fixture instance. */
  reset(initialValue = 1): void {
    this.nextValue = initialValue;
  }
}

export const DEFAULT_ACTOR_CONTEXT: ActorContext = {
  actorType: 'human_ui',
  actorId: 'test-recruiter'
};

/** Create an isolated actor context for a UI or agent operation fixture. */
export function createActorContext(
  overrides: Partial<ActorContext> = {}
): ActorContext {
  return {
    ...DEFAULT_ACTOR_CONTEXT,
    ...overrides
  };
}

export interface TestFactoryOptions {
  seed?: RepositorySeed;
  timestamp?: Timestamp;
  idPrefix?: string;
  actor?: Partial<ActorContext>;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

export interface TestContext {
  repository: SharedStateRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  actor: ActorContext;
}

/**
 * Create a fully deterministic test context backed by an isolated seed clone.
 * Callers can override individual dependencies when a test needs a custom
 * clock, ID source, seed, or actor context.
 */
export function createTestContext(
  options: TestFactoryOptions = {}
): TestContext {
  const clock = options.clock ?? new FixedClock(options.timestamp);
  const idGenerator =
    options.idGenerator ?? new DeterministicIdGenerator(options.idPrefix);
  const repository = new SharedStateRepository(
    deepClone(options.seed ?? createSeed()),
    { clock, idGenerator }
  );

  return {
    repository,
    clock,
    idGenerator,
    actor: createActorContext(options.actor)
  };
}

/** Create one seeded repository with deterministic test dependencies. */
export function createSeededRepository(
  options: TestFactoryOptions = {}
): SharedStateRepository {
  return createTestContext(options).repository;
}

/**
 * Create independent repositories with equivalent seeded state. Each call
 * receives a fresh seed clone and fresh default clock/ID generator, which is
 * useful for comparing operation adapters without shared mutable state.
 */
export function createSeededRepositoryClones(
  count = 2,
  options: TestFactoryOptions = {}
): SharedStateRepository[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Repository clone count must be a positive integer');
  }

  return Array.from({ length: count }, () =>
    createSeededRepository(options)
  );
}

/** Assert a synchronous property using the repository-wide 100-run minimum. */
export function assertProperty<Ts extends [unknown, ...unknown[]]>(
  property: IProperty<Ts>
): void {
  fc.assert(property, PROPERTY_TEST_OPTIONS);
}

/** Assert an asynchronous property using the same repository-wide run policy. */
export async function assertAsyncProperty<
  Ts extends [unknown, ...unknown[]]
>(property: IAsyncProperty<Ts>): Promise<void> {
  await fc.assert(property, PROPERTY_TEST_OPTIONS);
}
