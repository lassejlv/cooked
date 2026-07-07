# State management

[Docs index](./README.md) -> State management

Cooked has built-in state primitives. Use local `.ck` syntax inside components
and runtime stores for shared application state.

## Local component state

```rust
export fn Counter() {
  let mut count = 0
  let doubled => count * 2

  fn inc() {
    count += 1
  }

  rt ( <button onClick={inc}>{count} / {doubled}</button> )
}
```

## Stores

Use `createStore` for shared app state:

```ts
import { createStore, createActions } from "@cookedjs/cooked";

export const counter = createStore({ count: 0, label: "Cooked" });

export const counterActions = createActions(counter, ({ get, patch }) => ({
  inc() {
    patch({ count: get().count + 1 });
  },
  rename(label: string) {
    patch({ label });
  },
}));

export const count = counter.select((state) => state.count);
```

## Store API

```ts
const store = createStore({ count: 0 });

store.get();
store.set({ count: 1 });
store.update((state) => ({ count: state.count + 1 }));
store.patch({ count: 2 });

const count = store.select((state) => state.count);
const stop = store.subscribe((state) => state.count, (next, prev) => {
  console.log(prev, next);
});
```

Selectors are equality-checked. Effects and components that read a selected
accessor only update when that slice changes.

## Atoms

`atom(value)` is a tiny writable signal alias for local JavaScript/TypeScript
state outside `.ck` files:

```ts
import { atom } from "@cookedjs/cooked";

const open = atom(false);
open.set(true);
open.get();
```

## Related docs

- [Language guide](./language.md)
- [Architecture](./architecture.md)
