import { afterEach, describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  SharedStateRepository,
  type SharedStateRepository as Repo
} from '../src/server/repository';
import { FirestoreStateRepository } from '../src/server/persistence/firestoreStateRepository';
import { createSeed } from '../src/server/seed';
import type { ActivityLogEntry, JobRequisition } from '../src/shared/models';
import { FakeFirestore, flushMicrotasks } from './helpers/firestoreFake';

interface RepoFactory {
  name: string;
  create(): Promise<{ repository: Repo; cleanup(): Promise<void> }>;
}

function sampleJob(id: string): JobRequisition {
  return {
    id: id as JobRequisition['id'],
    title: 'Conformance Engineer',
    department: 'Engineering',
    requirements: ['ts'],
    compBand: { min: 100, max: 200, currency: 'USD' },
    status: 'open',
    createdBy: 'sarah-recruiter',
    createdAt: '2026-09-03T00:00:00.000Z'
  } as JobRequisition;
}

function sampleActivity(id: string): ActivityLogEntry {
  return {
    id: id as ActivityLogEntry['id'],
    toolName: 'create_job_requisition',
    actorType: 'human_ui',
    actorId: 'sarah-recruiter',
    input: {},
    output: {},
    timestamp: '2026-09-03T00:00:00.000Z'
  };
}

const factories: RepoFactory[] = [
  {
    name: 'SharedStateRepository (in-memory)',
    async create() {
      const repository = new SharedStateRepository(createSeed());
      return { repository, cleanup: async () => undefined };
    }
  },
  {
    name: 'FirestoreStateRepository (fake Firestore)',
    async create() {
      const firestore = new FakeFirestore() as unknown as Firestore;
      const repository = await FirestoreStateRepository.create({
        firestore,
        seed: createSeed(),
        crossInstanceSync: false
      });
      return {
        repository,
        cleanup: async () => {
          repository.stopRemoteSync();
          await repository.flush();
        }
      };
    }
  }
];

describe.each(factories)('repository conformance: $name', (factory) => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function make(): Promise<Repo> {
    const { repository, cleanup } = await factory.create();
    cleanups.push(cleanup);
    return repository;
  }

  it('returns isolated deep-cloned snapshots (callers cannot mutate state)', async () => {
    const repo = await make();
    const first = repo.read();
    (first.jobs as Map<string, unknown>).set('mutant', {});
    const second = repo.read();
    expect(second.jobs.has('mutant')).toBe(false);
  });

  it('commits one monotonic revision per transaction', async () => {
    const repo = await make();
    const start = repo.getRevision();
    repo.transact((draft) => {
      draft.jobs.set('job-conf-1', sampleJob('job-conf-1'));
    });
    expect(repo.getRevision()).toBe(start + 1);
    expect(repo.read().jobs.get('job-conf-1')?.title).toBe('Conformance Engineer');

    repo.transact((draft) => {
      draft.jobs.set('job-conf-2', sampleJob('job-conf-2'));
    });
    expect(repo.getRevision()).toBe(start + 2);
  });

  it('discards a throwing transaction without advancing revision', async () => {
    const repo = await make();
    const start = repo.getRevision();
    expect(() =>
      repo.transact(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(repo.getRevision()).toBe(start);
  });

  it('appends an audit-only revision without touching domain collections', async () => {
    const repo = await make();
    const startJobs = repo.read().jobs.size;
    const startLog = repo.read().activityLog.length;
    repo.appendActivity(sampleActivity('act-conf-1'));
    const snapshot = repo.read();
    expect(snapshot.activityLog.length).toBe(startLog + 1);
    expect(snapshot.jobs.size).toBe(startJobs);
  });

  it('notifies subscribers with a committed snapshot', async () => {
    const repo = await make();
    const seen: number[] = [];
    const unsubscribe = repo.subscribe((snapshot) => seen.push(snapshot.revision));
    repo.transact((draft) => draft.jobs.set('job-sub', sampleJob('job-sub')));
    unsubscribe();
    repo.transact((draft) => draft.jobs.set('job-sub-2', sampleJob('job-sub-2')));
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(repo.getRevision() - 1);
  });

  it('resets to the seed while keeping revisions monotonic', async () => {
    const repo = await make();
    repo.transact((draft) => draft.jobs.set('job-temp', sampleJob('job-temp')));
    const beforeReset = repo.getRevision();
    repo.reset();
    expect(repo.read().jobs.has('job-temp')).toBe(false);
    expect(repo.getRevision()).toBeGreaterThan(beforeReset);
  });

  it('sweeps expired approval cards identically', async () => {
    const repo = await make();
    repo.transact((draft) => {
      draft.approvalCards.set('appr-x', {
        id: 'appr-x',
        targetOperation: 'import_public_prospect',
        normalizedInput: {},
        requestFingerprint: 'fp',
        requestedBy: { actorType: 'human_ui', actorId: 'sarah-recruiter' },
        requestedAt: '2020-01-01T00:00:00.000Z',
        baseRevision: 0,
        targetFingerprint: 'tfp',
        affectedRecords: [],
        proposedOutput: {},
        changeSummary: [],
        warnings: [],
        requiredCapability: 'prospect.import',
        approvalPolicy: 'consent_and_human',
        status: 'pending',
        expiresAt: '2020-01-01T00:00:00.000Z',
        correlationId: 'c',
        traceId: 't'
      } as never);
    });
    const expired = repo.sweepExpiredApprovalCards('2026-09-03T00:00:00.000Z');
    expect(expired).toEqual(['appr-x']);
    expect(repo.read().approvalCards.get('appr-x')?.status).toBe('expired');
  });
});

describe('FirestoreStateRepository durability', () => {
  it('rehydrates a committed mutation on a fresh instance (survives restart)', async () => {
    const firestore = new FakeFirestore() as unknown as Firestore;

    const repoA = await FirestoreStateRepository.create({
      firestore,
      seed: createSeed(),
      crossInstanceSync: false
    });
    repoA.transact((draft) => draft.jobs.set('durable-job', sampleJob('durable-job')));
    const committedRevision = repoA.getRevision();
    await repoA.flush();
    repoA.stopRemoteSync();

    // A brand-new instance reads the persisted snapshot (a "restart").
    const repoB = await FirestoreStateRepository.create({
      firestore,
      crossInstanceSync: false
    });
    expect(repoB.getRevision()).toBe(committedRevision);
    expect(repoB.read().jobs.get('durable-job')?.title).toBe('Conformance Engineer');
    repoB.stopRemoteSync();
    await repoB.flush();
  });

  it('adopts revisions written by another instance via onSnapshot', async () => {
    const firestore = new FakeFirestore() as unknown as Firestore;

    const repoA = await FirestoreStateRepository.create({
      firestore,
      seed: createSeed()
    });
    const repoB = await FirestoreStateRepository.create({
      firestore
    });

    // Instance A commits; instance B should adopt it through the listener.
    repoA.transact((draft) => draft.jobs.set('shared-job', sampleJob('shared-job')));
    await repoA.flush();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(repoB.read().jobs.get('shared-job')?.title).toBe('Conformance Engineer');

    repoA.stopRemoteSync();
    repoB.stopRemoteSync();
    await repoA.flush();
    await repoB.flush();
  });
});
