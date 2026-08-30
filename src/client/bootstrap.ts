import { registerAllTools } from '../lib/webmcp';
import { synchronizationController } from './synchronization';

export interface SynchronizationLifecycle {
  start(): Promise<unknown>;
  stop(): void;
}

export interface ApplicationBootstrapOptions {
  synchronization?: SynchronizationLifecycle;
  registerTools?: () => unknown;
}

export interface ApplicationBootstrapHandle {
  /** Resolves after the initial authoritative state hydration completes. */
  readonly ready: Promise<void>;
  /** Release this consumer's lifecycle reference. The stop is deferred. */
  release(): void;
}

function defer(task: () => void): void {
  if (typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask(task);
    return;
  }
  void Promise.resolve().then(task);
}

/**
 * Owns the browser-only application startup boundary.
 *
 * React StrictMode intentionally runs an effect's setup and cleanup once
 * before the real setup. A reference count plus a deferred release lets that
 * probe reuse one registration, one initial hydration, and one SSE source,
 * while a genuine unmount still closes synchronization on the next microtask.
 */
export class ApplicationBootstrap {
  private readonly synchronization: SynchronizationLifecycle;
  private readonly registerTools: () => unknown;
  private references = 0;
  private stopToken = 0;
  private active = false;
  private registered = false;
  private ready: Promise<void> | null = null;

  constructor(options: ApplicationBootstrapOptions = {}) {
    this.synchronization = options.synchronization ?? synchronizationController;
    this.registerTools = options.registerTools ?? registerAllTools;
  }

  acquire(): ApplicationBootstrapHandle {
    this.references += 1;
    this.stopToken += 1;
    const ready = this.ensureStarted();
    let released = false;

    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.references = Math.max(0, this.references - 1);
        this.scheduleStop();
      }
    };
  }

  private ensureStarted(): Promise<void> {
    if (this.active && this.ready) return this.ready;

    this.active = true;
    let startup: Promise<void>;
    try {
      if (!this.registered) {
        this.registerTools();
        this.registered = true;
      }
      startup = this.synchronization.start().then(() => undefined);
    } catch (error) {
      startup = Promise.reject(error);
    }

    let tracked: Promise<void>;
    tracked = startup.then(
      () => undefined,
      (error) => {
        if (this.ready === tracked) {
          this.ready = null;
          this.active = false;
        }
        throw error;
      }
    );
    this.ready = tracked;
    return tracked;
  }

  private scheduleStop(): void {
    const token = this.stopToken;
    defer(() => {
      if (token !== this.stopToken || this.references > 0) return;
      this.active = false;
      this.ready = null;
      this.synchronization.stop();
    });
  }
}

export const applicationBootstrap = new ApplicationBootstrap();
