/**
 * A minimal in-memory Firestore fake sufficient to exercise the durable code
 * paths (`FirestoreStateRepository`, `FirestoreInvocationLedger`) WITHOUT a
 * network or emulator. It implements exactly the surface those modules use:
 *
 *   firestore.collection(name).doc(id).get()/set(data)/delete()/onSnapshot(cb,err)
 *   firestore.collection(name).get()
 *   firestore.collection(name).limit(n).get()
 *   firestore.batch().delete(ref).commit()
 *   firestore.settings(...)
 *
 * Data is deep-cloned on write and read so callers cannot mutate stored state
 * out of band — the same isolation the real client provides across the wire.
 * `onSnapshot` fires asynchronously on the next microtask, mirroring the real
 * listener so cross-instance sync can be tested deterministically with a flush.
 */

type DocData = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

type SnapshotListener = (snapshot: FakeDocSnapshot) => void;

class FakeDocSnapshot {
  constructor(
    readonly id: string,
    private readonly value: DocData | undefined
  ) {}
  get exists(): boolean {
    return this.value !== undefined;
  }
  data(): DocData | undefined {
    return this.value === undefined ? undefined : clone(this.value);
  }
}

class FakeQuerySnapshot {
  readonly docs: Array<{ id: string; ref: FakeDocRef; data(): DocData }>;
  constructor(entries: Array<[string, DocData]>, collection: FakeCollection) {
    this.docs = entries.map(([id, data]) => ({
      id,
      ref: collection.doc(id),
      data: () => clone(data)
    }));
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  forEach(cb: (doc: { id: string; data(): DocData }) => void): void {
    for (const doc of this.docs) cb(doc);
  }
}

class FakeDocRef {
  constructor(
    private readonly collection: FakeCollection,
    readonly id: string
  ) {}

  async get(): Promise<FakeDocSnapshot> {
    return new FakeDocSnapshot(this.id, this.collection.rawGet(this.id));
  }

  async set(data: DocData): Promise<void> {
    this.collection.rawSet(this.id, clone(data));
  }

  async delete(): Promise<void> {
    this.collection.rawDelete(this.id);
  }

  onSnapshot(listener: SnapshotListener, _onError?: (error: Error) => void): () => void {
    return this.collection.addListener(this.id, listener);
  }
}

class FakeQuery {
  constructor(
    private readonly collection: FakeCollection,
    private readonly max?: number
  ) {}
  limit(n: number): FakeQuery {
    return new FakeQuery(this.collection, n);
  }
  async get(): Promise<FakeQuerySnapshot> {
    return this.collection.snapshotAll(this.max);
  }
}

class FakeCollection {
  private readonly docs = new Map<string, DocData>();
  private readonly listeners = new Map<string, Set<SnapshotListener>>();

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this, id);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this, n);
  }
  async get(): Promise<FakeQuerySnapshot> {
    return this.snapshotAll();
  }

  snapshotAll(max?: number): FakeQuerySnapshot {
    let entries = [...this.docs.entries()];
    if (max !== undefined) entries = entries.slice(0, max);
    return new FakeQuerySnapshot(entries, this);
  }

  rawGet(id: string): DocData | undefined {
    const value = this.docs.get(id);
    return value === undefined ? undefined : clone(value);
  }
  rawSet(id: string, data: DocData): void {
    this.docs.set(id, data);
    this.notify(id);
  }
  rawDelete(id: string): void {
    this.docs.delete(id);
    this.notify(id);
  }

  addListener(id: string, listener: SnapshotListener): () => void {
    let set = this.listeners.get(id);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    // Fire the current value asynchronously, like the real onSnapshot.
    queueMicrotask(() => listener(new FakeDocSnapshot(id, this.rawGet(id))));
    return () => set!.delete(listener);
  }

  private notify(id: string): void {
    const set = this.listeners.get(id);
    if (set === undefined) return;
    const snapshot = new FakeDocSnapshot(id, this.rawGet(id));
    // Async delivery mirrors Firestore, avoiding synchronous re-entrancy.
    for (const listener of set) queueMicrotask(() => listener(snapshot));
  }
}

class FakeBatch {
  private readonly ops: Array<() => Promise<void>> = [];
  delete(ref: FakeDocRef): FakeBatch {
    this.ops.push(() => ref.delete());
    return this;
  }
  set(ref: FakeDocRef, data: DocData): FakeBatch {
    this.ops.push(() => ref.set(data));
    return this;
  }
  async commit(): Promise<void> {
    for (const op of this.ops) await op();
  }
}

export class FakeFirestore {
  private readonly collections = new Map<string, FakeCollection>();

  collection(name: string): FakeCollection {
    let collection = this.collections.get(name);
    if (collection === undefined) {
      collection = new FakeCollection();
      this.collections.set(name, collection);
    }
    return collection;
  }

  batch(): FakeBatch {
    return new FakeBatch();
  }

  settings(_options: unknown): void {
    // no-op; the real client uses this for ignoreUndefinedProperties.
  }
}

/** Flush queued microtasks so onSnapshot deliveries settle in a test. */
export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Cast helper: the fake structurally satisfies the subset of the Admin
 * Firestore API our durable modules touch. The durable modules accept a
 * `Firestore`, so we assert the fake as `unknown` at the call site.
 */
export function asFirestore(fake: FakeFirestore): never {
  return fake as unknown as never;
}
