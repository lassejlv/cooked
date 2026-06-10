import { batch, effect, signal, untrack, type Accessor } from "./reactive.js";

export type Equality<T> = (prev: T, next: T) => boolean;
export type StoreUpdater<T> = T | ((prev: T) => T);
export type Patch<T extends object> = Partial<T> | ((prev: T) => Partial<T>);

export interface Store<T> extends Accessor<T> {
  set(next: StoreUpdater<T>): void;
  update(fn: (prev: T) => T): void;
  patch(patch: Patch<Extract<T, object>>): void;
  select<U>(selector: (state: T) => U, equals?: Equality<U>): Accessor<U>;
  subscribe(listener: (state: T, prev: T) => void): () => void;
  subscribe<U>(
    selector: (state: T) => U,
    listener: (slice: U, prev: U) => void,
    equals?: Equality<U>,
  ): () => void;
}

const same: Equality<unknown> = Object.is;

export function createStore<T>(initial: T): Store<T> {
  const state = signal(initial);

  const store = {
    get: () => state.get(),
    set(next: StoreUpdater<T>) {
      state.set(resolve(next, untrack(() => state.get())));
    },
    update(fn: (prev: T) => T) {
      store.set(fn);
    },
    patch(patch: Patch<Extract<T, object>>) {
      store.set((prev) => {
        if (prev == null || typeof prev !== "object") {
          throw new Error("cooked: store.patch only works with object state");
        }
        const partial =
          typeof patch === "function"
            ? patch(prev as Extract<T, object>)
            : patch;
        return { ...(prev as object), ...partial } as T;
      });
    },
    select<U>(selector: (state: T) => U, equals: Equality<U> = same): Accessor<U> {
      const selected = signal(selector(untrack(() => state.get())));
      effect(() => {
        const next = selector(state.get());
        const prev = untrack(() => selected.get());
        if (!equals(prev, next)) selected.set(next);
      });
      return { get: () => selected.get() };
    },
    subscribe<U>(
      first: ((state: T) => U) | ((state: T, prev: T) => void),
      second?: ((slice: U, prev: U) => void),
      equals: Equality<U> = same,
    ): () => void {
      if (second) {
        const selector = first as (state: T) => U;
        let prev = selector(untrack(() => state.get()));
        return effect(() => {
          const next = selector(state.get());
          if (equals(prev, next)) return;
          const old = prev;
          prev = next;
          second(next, old);
        });
      }

      const listener = first as (state: T, prev: T) => void;
      let prev = untrack(() => state.get());
      return effect(() => {
        const next = state.get();
        if (Object.is(prev, next)) return;
        const old = prev;
        prev = next;
        listener(next, old);
      });
    },
  } satisfies Store<T>;

  return store;
}

export function createActions<T, A extends Record<string, unknown>>(
  store: Store<T>,
  factory: (api: Pick<Store<T>, "get" | "set" | "update" | "patch">) => A,
): A {
  return factory({
    get: store.get,
    set: (next) => batch(() => store.set(next)),
    update: (fn) => batch(() => store.update(fn)),
    patch: (patch) => batch(() => store.patch(patch as never)),
  });
}

export const atom = signal;

function resolve<T>(next: StoreUpdater<T>, prev: T): T {
  return typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
}
