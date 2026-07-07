# @cookedjs/cooked

Runtime for [Cooked](https://github.com/lassejlv/cooked) — a compiled UI
language with fine-grained reactivity, zero virtual DOM, a built-in type-safe
file-based router, and minimal SSR.

```bash
npm i @cookedjs/cooked @cookedjs/vite-plugin-cooked
```

```ts
import { mount } from "@cookedjs/cooked";
import { createRouter, Link, navigate } from "@cookedjs/cooked/router";
import { renderToString, createSsrServer } from "@cookedjs/cooked/server";
import { createServerFn, ServerFnError } from "@cookedjs/cooked/fn";
```

- `@cookedjs/cooked` — signals, effects, stores, DOM helpers, `mount`
- `@cookedjs/cooked/router` — type-safe file-based router
- `@cookedjs/cooked/server` — SSR: `renderToString`, `createSsrServer` (node + bun presets), API-route + server-fn pipeline
- `@cookedjs/cooked/fn` — type-safe server functions with validator + middleware

Pairs with [`@cookedjs/vite-plugin-cooked`](https://www.npmjs.com/package/@cookedjs/vite-plugin-cooked),
which compiles `.ck` files and wires routing/SSR into Vite.
