import { describe, expect, it } from 'vitest';
import { ApplicationBootstrap, type SynchronizationLifecycle } from '../src/client/bootstrap';

class FakeSynchronization implements SynchronizationLifecycle {
  startCalls = 0;
  stopCalls = 0;

  start(): Promise<unknown> {
    this.startCalls += 1;
    return Promise.resolve({ revision: 0 });
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

describe('application bootstrap lifecycle', () => {
  it('coalesces StrictMode setup/cleanup with one registration and hydration', async () => {
    const synchronization = new FakeSynchronization();
    let registrationCalls = 0;
    const bootstrap = new ApplicationBootstrap({
      synchronization,
      registerTools: () => {
        registrationCalls += 1;
      }
    });

    const first = bootstrap.acquire();
    first.release();
    const second = bootstrap.acquire();

    expect(second.ready).toBe(first.ready);
    await second.ready;
    await Promise.resolve();

    expect(registrationCalls).toBe(1);
    expect(synchronization.startCalls).toBe(1);
    expect(synchronization.stopCalls).toBe(0);

    second.release();
    await Promise.resolve();
    expect(synchronization.stopCalls).toBe(1);
  });

  it('closes synchronization on a genuine unmount and reuses registration on remount', async () => {
    const synchronization = new FakeSynchronization();
    let registrationCalls = 0;
    const bootstrap = new ApplicationBootstrap({
      synchronization,
      registerTools: () => {
        registrationCalls += 1;
      }
    });

    const first = bootstrap.acquire();
    await first.ready;
    first.release();
    await Promise.resolve();
    expect(synchronization.stopCalls).toBe(1);

    const second = bootstrap.acquire();
    await second.ready;
    expect(synchronization.startCalls).toBe(2);
    expect(registrationCalls).toBe(1);
    second.release();
    await Promise.resolve();
  });
});
