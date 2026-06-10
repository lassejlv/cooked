# Cooked

A compiled web UI framework with fine-grained reactivity, built-in state, and
zero virtual DOM.

Cooked `.ck` files compile to imperative DOM code backed by a tiny runtime. The
compiler is written in Rust, shipped to JavaScript through napi-rs, and wired
into Vite with `vite-plugin-cooked`.

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

## Highlights

- Rust compiler with TypeScript-first expressions.
- Fine-grained signals, effects, derived values, keyed lists, and zero virtual DOM.
- Built-in typed stores, atoms, selectors, and actions.
- Vite plugin with source maps, generated `.d.ck.ts` files, and HMR remounting.
- Rust `tower-lsp` language server for completion, hover, diagnostics, symbols, and CSS help.
- Tiny runtime and direct DOM output.

## Docs

- [Docs index](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Language guide](./docs/language.md)
- [State management](./docs/state.md)
- [Tooling](./docs/tooling.md)
- [Language server](./docs/language-server.md)
- [Architecture](./docs/architecture.md)
- [Development](./docs/development.md)

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @cooked/example-counter dev
```

See [Getting started](./docs/getting-started.md) for the full local workflow.

## Repository

| Path | What |
|------|------|
| [`crates/cooked_compiler`](./crates/cooked_compiler) | Rust parser, rewriter, JSX codegen |
| [`crates/cooked_lsp`](./crates/cooked_lsp) | `tower-lsp` language server with TypeScript service integration |
| [`crates/cooked_napi`](./crates/cooked_napi) | napi-rs compiler binding |
| [`packages/runtime`](./packages/runtime) | Runtime, DOM helpers, stores |
| [`packages/vite-plugin-cooked`](./packages/vite-plugin-cooked) | Vite plugin |
| [`examples/counter`](./examples/counter) | Example app and tests |
