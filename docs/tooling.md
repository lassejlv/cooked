# Tooling

[Docs index](./README.md) -> Tooling

Cooked is compiled by a Rust compiler exposed to JavaScript through napi-rs and
used by `vite-plugin-cooked`.

## Vite plugin

```ts
import { defineConfig } from "vite";
import cooked from "@cookedjs/vite-plugin-cooked";

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
/// <reference types="@cookedjs/vite-plugin-cooked/client" />
```

The Vite plugin emits `.d.ck.ts` files into `node_modules/.cooked/types/`
(mirroring your source tree) so generated files stay out of your project. Point
TypeScript at them with `rootDirs` in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "allowArbitraryExtensions": true,
    "rootDirs": [".", "./node_modules/.cooked/types"]
  }
}
```

Set `cooked({ declarations: false })` to disable emission, or
`cooked({ declarationsDir: "..." })` to change the output location.

## File-based routing

The plugin scans `src/routes/` (configurable via `cooked({ routesDir })`) and
serves the route table through the `virtual:cooked-routes` module, plus a
generated `cooked-routes.d.ts` that makes `Link`/`navigate` path- and
param-checked. See [Router](./router.md).

Named component exports get generated declarations from `.ck` prop annotations.
Props without annotations fall back to `unknown`.

## Tailwind CSS

Tailwind v4 works out of the box alongside the Cooked plugin:

```ts
// vite.config.ts
import cooked from "@cookedjs/vite-plugin-cooked";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({ plugins: [cooked(), tailwindcss()] });
```

```css
/* src/style.css */
@import "tailwindcss";

/* Tailwind's scanner doesn't know the .ck extension — point it there. */
@source "./**/*.ck";
```

Import the CSS from your entry module and use utility classes in `.ck`
markup as usual.

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
