# Language Server

[Docs index](./README.md) -> Language Server

Cooked ships a Rust language server in
[`crates/cooked_lsp`](../crates/cooked_lsp). The server is built with
`tower-lsp` and runs over stdio so editors can launch it directly.

```bash
pnpm lsp
```

For editor integrations, point the language client at:

```bash
cargo run -p cooked_lsp --bin cooked-lsp
```

## Features

- `.ck` document sync through LSP `textDocument/didOpen` and
  `textDocument/didChange`.
- Cooked compiler errors surfaced as LSP diagnostics.
- TypeScript semantic diagnostics, hover, completion, and same-file definition
  lookup through the installed TypeScript compiler service.
- Cooked snippets for `export fn`, `let mut`, `derived`, `effect`, `rt`, and
  `Keyed`.
- Runtime completions for stores, atoms, signals, memos, effects, and batches.
- CSS property completions and warnings inside `style={{ ... }}` objects.
- Document symbols and local definition lookup for top-level `.ck` exports.

## TypeScript Service

The LSP keeps the editor-facing server in Rust, then asks the TypeScript
compiler API for TypeScript-aware answers. It launches
[`typescript_service.mjs`](../crates/cooked_lsp/typescript_service.mjs) with
`bun` first and falls back to `node`.

The helper converts Cooked syntax to virtual TSX while preserving positions in
component bodies. That gives the editor TypeScript completions such as
`toUpperCase`, typed hover such as `(parameter) name: string`, and errors such
as assigning a `string` to a `number`.

Environment overrides:

```bash
COOKED_TYPESCRIPT_RUNNER=node pnpm lsp
COOKED_TYPESCRIPT_SERVICE=/absolute/path/to/typescript_service.mjs pnpm lsp
```

If neither `bun` nor `node` can run the helper, the LSP still serves Cooked
compiler diagnostics, snippets, CSS completions, symbols, and local hovers.

## Validation

```bash
cargo test -p cooked_lsp
pnpm check
```

See [Tooling](./tooling.md) for the Vite plugin and declaration generation.
