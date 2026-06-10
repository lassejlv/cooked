# Tooling

[Docs index](./README.md) -> Tooling

Cooked is compiled by a Rust compiler exposed to JavaScript through napi-rs and
used by `vite-plugin-cooked`.

## Vite plugin

```ts
import { defineConfig } from "vite";
import cooked from "vite-plugin-cooked";

export default defineConfig({
  plugins: [cooked()],
});
```

Options:

```ts
cooked({
  declarations: true,
  include: /\.ck$/,
});
```

## TypeScript declarations

For TypeScript projects, add:

```ts
/// <reference types="vite-plugin-cooked/client" />
```

The Vite plugin emits sibling `.d.ck.ts` files next to compiled `.ck` modules by
default. Set `cooked({ declarations: false })` to disable this.

Named component exports get generated declarations from `.ck` prop annotations.
Props without annotations fall back to `unknown`.

## Source maps and diagnostics

The compiler returns source maps to Vite. Compiler errors include the source
filename and line/column context when the compiler can locate the failing span.

## HMR

In development, `.ck` edits remount active instances from the updated module
without a full page reload. Preserving component-local state across replacement
is still on the roadmap.

## Language server

Cooked includes a Rust LSP server built with `tower-lsp`:

```bash
pnpm lsp
```

For editor integrations, point the language client at:

```bash
cargo run -p cooked_lsp --bin cooked-lsp
```

The server supports `.ck` document sync, compiler diagnostics, completion,
hover, document symbols, definition lookup, TypeScript compiler-service
completion/hover/diagnostics, and CSS property completions inside
`style={{ ... }}`.

See [Language server](./language-server.md) for editor wiring and the
TypeScript service bridge.

## Related docs

- [Getting started](./getting-started.md)
- [Language guide](./language.md)
- [Language server](./language-server.md)
- [Development](./development.md)
