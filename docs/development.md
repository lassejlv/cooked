# Development

[Docs index](./README.md) -> Development

## Common commands

```bash
pnpm install
pnpm build
pnpm test
pnpm check
```

## Package-specific commands

```bash
pnpm --filter @cooked/binding build:debug
pnpm --filter cooked build
pnpm --filter vite-plugin-cooked build
pnpm build:lsp
pnpm --filter @cooked/example-counter dev
pnpm lsp
```

## Validation

The full local gate is:

```bash
pnpm check
```

It runs:

- `cargo fmt --check`
- `cargo check`
- `cargo test -p cooked_compiler`
- `cargo test -p cooked_lsp`
- `pnpm build`
- `pnpm test`

## CI

GitHub Actions runs the same core validation from
[`/.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Related docs

- [Architecture](./architecture.md)
- [Tooling](./tooling.md)
