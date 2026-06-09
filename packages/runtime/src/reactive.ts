/**
 * Fine-grained reactivity for Cooked — accessor model.
 *
 * The compiler inserts `.get()` on reactive reads and `.set(...)` on writes,
 * so user code never sees these methods directly. Memos are derived, effects
 * are side-effects, both auto-track the signals they read.
 *
 * Computations form an ownership tree: an effect created while another
 * computation is running is disposed when that owner re-runs or is disposed.
 * This is what keeps conditionals and lists leak-free — when `insert` swaps a
 * branch out, every effect created while building the old branch dies with it.
 *
 * This is intentionally small and synchronous (microtask-free): a write flushes
 * its dependents immediately unless wrapped in `batch`. Good enough for the MVP;
 * a topological/lazy scheduler can replace `flush` later without changing the API.
 */

export interface Accessor<T> {
  get(): T;
}

export interface Signal<T> extends Accessor<T> {
  set(value: T): void;
}

interface Computation {
  /** re-run the computation body */
  run(): void;
  /** signals this computation currently depends on */
  deps: Set<SignalNode<unknown>>;
  /** disposers registered via onCleanup during the last run */
  cleanups: Array<() => void>;
  /** computations created while this one was running (disposed on re-run) */
  children: Computation[];
}

class SignalNode<T> {
  value: T;
  observers = new Set<Computation>();
  constructor(value: T) {
    this.value = value;
  }
  read(): T {
    if (activeComputation) {
      this.observers.add(activeComputation);
      activeComputation.deps.add(this as SignalNode<unknown>);
    }
    return this.value;
  }
  write(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    // Snapshot: observers can change as they re-run.
    for (const obs of [...this.observers]) schedule(obs);
    if (batchDepth === 0) flush();
  }
}

/** The computation whose dependencies are being tracked (null in untrack). */
let activeComputation: Computation | null = null;
/** The computation that owns newly created effects (survives untrack). */
let activeOwner: Computation | null = null;
let batchDepth = 0;
const pending = new Set<Computation>();

function schedule(c: Computation): void {
  pending.add(c);
}

function flush(): void {
  // Re-runs may schedule further work; drain until stable.
  let guard = 0;
  while (pending.size > 0) {
    if (guard++ > 100_000) throw new Error("cooked: reactive update did not settle (cycle?)");
    const batch = [...pending];
    pending.clear();
    for (const c of batch) c.run();
  }
}

function disposeComputation(c: Computation): void {
  for (const child of c.children) disposeComputation(child);
  c.children = [];
  for (const dep of c.deps) dep.observers.delete(c);
  c.deps.clear();
  for (const fn of c.cleanups) fn();
  c.cleanups = [];
  // A disposed computation must not run from a pending flush.
  pending.delete(c);
}

/** Create a writable reactive value. */
export function signal<T>(value: T): Signal<T> {
  const node = new SignalNode(value);
  return {
    get: () => node.read(),
    set: (v: T) => node.write(v),
  };
}

/** Create a reactive side-effect. The body may return a cleanup function. */
export function effect(fn: () => void | (() => void)): () => void {
  const comp: Computation = {
    deps: new Set(),
    cleanups: [],
    children: [],
    run() {
      disposeComputation(comp);
      const prevComp = activeComputation;
      const prevOwner = activeOwner;
      activeComputation = comp;
      activeOwner = comp;
      try {
        const ret = fn();
        if (typeof ret === "function") comp.cleanups.push(ret);
      } finally {
        activeComputation = prevComp;
        activeOwner = prevOwner;
      }
    },
  };
  if (activeOwner) activeOwner.children.push(comp);
  comp.run();
  return () => disposeComputation(comp);
}

/** Create a cached derived value. Recomputes when its dependencies change. */
export function memo<T>(fn: () => T): Accessor<T> {
  const node = new SignalNode<T>(undefined as unknown as T);
  let initialized = false;
  effect(() => {
    const next = fn();
    if (!initialized) {
      node.value = next;
      initialized = true;
    } else {
      node.write(next);
    }
  });
  return { get: () => node.read() };
}

/**
 * Run `fn` under a fresh ownership root, detached from any current computation.
 * Effects created inside live until the returned/received `dispose` is called.
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner: Computation = {
    deps: new Set(),
    cleanups: [],
    children: [],
    run() {},
  };
  const dispose = () => disposeComputation(owner);
  const prevComp = activeComputation;
  const prevOwner = activeOwner;
  activeComputation = null;
  activeOwner = owner;
  try {
    return fn(dispose);
  } finally {
    activeComputation = prevComp;
    activeOwner = prevOwner;
  }
}

/** Register a disposer that runs before the owning computation re-runs (or is disposed). */
export function onCleanup(fn: () => void): void {
  if (activeOwner) activeOwner.cleanups.push(fn);
}

/** Read without subscribing the active computation. */
export function untrack<T>(fn: () => T): T {
  const prev = activeComputation;
  activeComputation = null;
  try {
    return fn();
  } finally {
    activeComputation = prev;
  }
}

/** Batch multiple writes so dependents flush once at the end. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}
