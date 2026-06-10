# Getting started

[Docs index](./README.md) -> Getting started

## Install

```bash
pnpm install
```

Cooked currently uses `pnpm@11.5.2` in this repository.

## Build the local packages

```bash
pnpm --filter @cooked/binding build:debug
pnpm --filter cooked build
pnpm --filter vite-plugin-cooked build
```

Or run the root build:

```bash
pnpm build
```

## Run the example app

```bash
pnpm --filter @cooked/example-counter dev
```

The example lives in [`examples/counter`](../examples/counter).

## A first component

```rust
export fn Counter(label: string = "Count") {
  let mut count = 0
  let doubled => count * 2

  fn inc() {
    count += 1
  }

  rt (
    <div class="counter">
      <h1>{label}: {count} (x2 = {doubled})</h1>
      <button onClick={inc}>+</button>
    </div>
  )
}
```

The compiler rewrites reactive reads and writes for you. You write `count`; the
generated JavaScript calls `count.get()` and `count.set(...)`.

## Next

- Learn the component syntax in the [language guide](./language.md).
- Use shared state with [state management](./state.md).
- Understand Vite, HMR, and declarations in [tooling](./tooling.md).
