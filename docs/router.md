# Router

Cooked ships a built-in, type-safe, file-based router inspired by
[TanStack Router](https://tanstack.com/router). Routes are `.ck` files under
`src/routes/`; the Vite plugin scans them, code-splits each route, and
generates a type registry so `Link` and `navigate` are checked against real
paths and params at compile time.

## File conventions

| File                        | Route          | Params               |
| --------------------------- | -------------- | -------------------- |
| `src/routes/index.ck`       | `/`            | —                    |
| `src/routes/about.ck`       | `/about`       | —                    |
| `src/routes/posts/index.ck` | `/posts`       | —                    |
| `src/routes/posts/$id.ck`   | `/posts/$id`   | `{ id: string }`     |
| `src/routes/docs/$.ck`      | `/docs/$`      | `{ splat: string }`  |
| `src/routes/__layout.ck`    | layout         | wraps its dir tree   |

Matching prefers static segments over `$param` segments over `$` splats, so
`/posts/new` wins over `/posts/$id`.

A route module needs a default export or exactly one exported component. The
matched leaf component receives the params as a `params` prop.

## Setup

```ts
// src/main.ts
import { mount } from "cooked";
import { createRouter } from "cooked/router";
import { routes } from "virtual:cooked-routes";

const router = createRouter({ routes });
mount(router.view, document.getElementById("app")!);
```

`createRouter` accepts `base` (app base path) and `notFound` (component
rendered when nothing matches).

## Layouts

`__layout.ck` wraps every route in its directory tree and receives the matched
page as `children`:

```rust
import { Link } from "cooked/router"

export fn Layout() {
  rt (
    <div>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/posts/$id" params={{ id: "42" }}>Post 42</Link>
      </nav>
      <main>{children}</main>
    </div>
  )
}
```

Nested directories nest their layouts (outermost first).

## Navigation

```ts
import { navigate, useParams, useSearch, usePathname } from "cooked/router";

navigate("/posts/$id", { params: { id: "7" }, search: { tab: "comments" } });
navigate("/about", { replace: true });

const params = useParams();   // reactive: params.get().id
const search = useSearch();   // reactive: search.get().tab
const path = usePathname();   // reactive current pathname
```

`Link` renders an `<a>` with a real `href` and intercepts plain left-clicks;
modified clicks and `target` fall through to the browser.

## Type safety

The plugin writes `node_modules/.cooked/types/cooked-routes.d.ts`, which
registers every route with `cooked/router`:

```ts
navigate("/nope");                                 // error: unknown route
navigate("/posts/$id");                            // error: params required
navigate("/posts/$id", { params: { slug: "x" } }); // error: wrong param name
```

Include the generated file in `tsconfig.json`:

```jsonc
{
  "include": ["src", "node_modules/.cooked/types/cooked-routes.d.ts"]
}
```

Routes are re-scanned when files are added or removed; the dev server reloads
and the registry regenerates automatically.

## Code splitting

Each route (and layout) is loaded through a dynamic `import()`, so production
builds emit one chunk per route out of the box.
