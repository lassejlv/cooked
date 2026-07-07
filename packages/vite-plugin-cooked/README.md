# @cookedjs/vite-plugin-cooked

Vite plugin for [Cooked](https://github.com/lassejlv/cooked): compiles `.ck`
files via the native Rust compiler and wires up the framework.

```bash
npm i @cookedjs/cooked @cookedjs/vite-plugin-cooked
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import cooked from "@cookedjs/vite-plugin-cooked";

export default defineConfig({ plugins: [cooked()] });
```

What it does:

- Compiles `.ck` to JS with source maps and HMR.
- File-based routing from `src/routes/` via `virtual:cooked-routes`, plus a
  generated type registry making `Link`/`navigate` path- and param-checked.
- Zero-config SSR when `src/entry-server.ts` exists: `vite` serves SSR in
  dev, `vite build` emits `dist/client` + `dist/server`.
- API routes (`.ts` files under `src/routes`) and secure server functions
  (`createServerFn` in any module — client bundles get RPC stubs).
- Editor type declarations emitted to `node_modules/.cooked/types/`.
