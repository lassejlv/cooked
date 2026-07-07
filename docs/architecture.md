# Architecture

[Docs index](./README.md) -> Architecture

Cooked compiles `.ck` files to imperative DOM code targeting the `cooked`
runtime.

```text
.ck -> cooked_compiler (Rust) -> JS module
       parser -> structural grammar; JSX + TS spans kept raw
       rewrite -> reactive reads/writes and TypeScript erasure
       jsx/codegen -> document.createElement + runtime helpers
       |
       v
   cooked_napi -> @cookedjs/binding
       |
       v
   vite-plugin-cooked
       |
       v
   cooked runtime
```

## Compiler

[`crates/cooked_compiler`](../crates/cooked_compiler) owns parsing, rewriting,
JSX code generation, source maps, diagnostics, and declaration output.

The compiler rewrites:

- reactive reads to `.get()`
- reactive writes to `.set(...)`
- component props to `props.x`
- JSX to imperative DOM construction

## Binding

[`crates/cooked_napi`](../crates/cooked_napi) exposes the Rust compiler to
JavaScript as `@cookedjs/binding`.

## Runtime

[`packages/runtime`](../packages/runtime) provides:

- `signal`, `memo`, `effect`, `batch`, `createRoot`
- DOM helpers like `insert`, `keyed`, `spread`, `setAttr`, `setProp`
- mounting and HMR replacement helpers
- built-in stores and atoms

The runtime keeps an ownership tree. Effects created while building a view region
are disposed when that region is replaced, so conditionals and lists do not leak.

## Vite plugin

[`packages/vite-plugin-cooked`](../packages/vite-plugin-cooked) compiles `.ck`
files in Vite's `transform` hook and emits source maps and declaration files.

## Related docs

- [Language guide](./language.md)
- [State management](./state.md)
- [Tooling](./tooling.md)
