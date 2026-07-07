# Cooked docs

Cooked is a compiled web UI framework with fine-grained reactivity, built-in
state, and zero virtual DOM.

## Start here

- [Getting started](./getting-started.md) - install, build, run the example app.
- [Language guide](./language.md) - `.ck` components, JSX, reactivity, lists, props.
- [State management](./state.md) - built-in stores, atoms, selectors, actions.
- [Router](./router.md) - type-safe file-based routing, layouts, params, code splitting.
- [Tooling](./tooling.md) - Vite plugin, TypeScript declarations, HMR, source maps.
- [Language server](./language-server.md) - editor completions, hover, diagnostics, CSS, TypeScript service.
- [Architecture](./architecture.md) - compiler/runtime layout and data flow.
- [Development](./development.md) - repo commands, validation, CI.

## Current limitations

- Scoped `style` blocks are not implemented.
- HMR remounts active instances, but does not preserve component-local state yet.

## Package map

| Path | What |
|------|------|
| [`crates/cooked_compiler`](../crates/cooked_compiler) | Rust parser, reactive rewriter, JSX codegen |
| [`crates/cooked_lsp`](../crates/cooked_lsp) | `tower-lsp` language server with TypeScript service integration |
| [`crates/cooked_napi`](../crates/cooked_napi) | napi-rs binding published as `@cooked/binding` |
| [`packages/runtime`](../packages/runtime) | `cooked` runtime: reactivity, DOM helpers, stores |
| [`packages/vite-plugin-cooked`](../packages/vite-plugin-cooked) | Vite transform plugin for `.ck` |
| [`examples/counter`](../examples/counter) | Counter/todo/async greeting example and tests |
