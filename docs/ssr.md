# Server rendering

Cooked ships a minimal built-in SSR framework (TanStack Start / Next.js
style) — no extra packages: it's part of `cooked` + `vite-plugin-cooked`.
See [`examples/ssr`](../examples/ssr).

## Zero config

Add `src/entry-server.ts` and everything switches on:

```ts
// src/entry-server.ts
import { renderToString, type RenderResult } from "@cookedjs/cooked/server";
import { routes } from "virtual:cooked-routes";

export function render(url: string): Promise<RenderResult> {
  return renderToString(routes, url);
}
```

```ts
// src/entry-client.ts
import { mount } from "@cookedjs/cooked";
import { createRouter } from "@cookedjs/cooked/router";
import { routes } from "virtual:cooked-routes";

const app = document.getElementById("app")!;
app.innerHTML = "";
mount(createRouter({ routes }).view, app);
```

```html
<!-- index.html -->
<div id="app"><!--ssr-outlet--></div>
<script type="module" src="/src/entry-client.ts"></script>
```

- `vite` — dev server with SSR, HMR, API routes, and server functions.
- `vite build` — builds `dist/client` and `dist/server` in one go (no flags).
- production: a 2-line `server.js`, runs on **node or bun**:

```js
import { createSsrServer } from "@cookedjs/cooked/server";
// preset "auto" (default) picks native Bun.serve() under bun, node:http on node.
createSsrServer({ root: import.meta.dirname, preset: "auto" });
```

Pages render on the server (happy-dom) and the client takes over on load.
Unmatched URLs render the router's not-found state with a 404 status.

## API routes

Any `.ts`/`.js` file under `src/routes` (anywhere — no `api/` folder
required) is an API route. Export HTTP-method handlers taking a web
`Request` and returning a web `Response`:

```ts
// src/routes/health.ts            -> GET /health
// src/routes/api/posts/$id.ts     -> GET /api/posts/:id
import type { ApiContext } from "@cookedjs/cooked/server";

export function GET(request: Request, { params }: ApiContext): Response {
  return Response.json({ id: params.id });
}

export async function POST(request: Request): Promise<Response> {
  return Response.json(await request.json(), { status: 201 });
}
```

`$param` and `$` splat segments work like page routes; static segments win
over dynamic ones. Missing methods get a 405 with an `Allow` header.

## Server functions

Type-safe RPC with validation and middleware built in — definable in **any
module**, including `.ck` files:

```ts
import { createServerFn, ServerFnError } from "@cookedjs/cooked/fn";

export const greet = createServerFn()
  .middleware(async ({ request, context }) => {
    if (!(await isAuthed(request))) throw new ServerFnError("Unauthorized", 401);
    return { startedAt: Date.now() }; // merged into context
  })
  .validator((input: { name: string }) => {
    if (typeof input?.name !== "string") throw new ServerFnError("name required");
    return { name: input.name.trim() };
  })
  .handler(({ input, request, context }) => ({ message: `Hello ${input.name}` }));
```

Client code just calls it — fully typed end to end:

```ts
const { message } = await greet({ name: "cook" });
```

Under the hood it's a POST to `/_cooked/fn/<id>`; during SSR the call runs
directly with no HTTP.

Security model:

- Client bundles never contain server-function code: `*.server.ts` modules
  are replaced entirely with RPC stubs; `createServerFn` exports in mixed
  modules are rewritten in place.
- Without a `.validator()`, the handler's `input` is `undefined` — raw
  client payloads never reach handlers unvalidated.
- Only functions created by `createServerFn` in plugin-discovered modules
  are callable; the endpoint is POST-only, JSON-only, and rejects
  cross-site/cross-origin browser requests.
- `ServerFnError` messages (and status) reach the client; anything else is
  logged server-side and returned as a generic 500.

Caveat: in a mixed module the *other* top-level code still ships to the
client — keep heavy or secret server-only imports inside handlers or in
`*.server.ts` files.

## How it works

- `renderToString(routes, url)` renders the router in a fresh happy-dom
  window per request (renders are serialized process-wide) and waits for
  route chunks/async components to settle.
- The Vite plugin injects the api-route and server-fn manifests into your
  server entry, serves the SSR middleware in dev, and configures the
  client + ssr build environments for `vite build`.
- `createFetchHandler` (web `Request` -> `Response`) is the core pipeline —
  plug it into `Bun.serve()` or any fetch-style runtime; `createRequestHandler`
  is the node req/res adapter over it.
