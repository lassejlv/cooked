/**
 * Server rendering, built into Cooked — `@cookedjs/cooked/server`.
 *
 * `renderToString` renders the file-based router for a URL inside a happy-dom
 * window and returns the markup. The client entry then mounts the same router
 * over it (takeover: the server markup is replaced by an identical client
 * render — fine at this scale, no attach-hydration).
 *
 * `createSsrServer` is a minimal Next-style node server: in dev it runs Vite
 * in middleware mode (HMR included) and renders through `ssrLoadModule`; in
 * prod it serves `dist/client` statically and renders through the built
 * `dist/server` entry.
 *
 * happy-dom globals are process-wide, so renders are serialized through a
 * queue; each render gets a fresh window.
 */

import { Window } from "happy-dom";
import { mount } from "./dom.js";
import { createRouter, matchRoutes, type RouteDefinition } from "./router.js";

export { createServerFn, ServerFnError } from "./fn.js";
export type { ServerFn, ServerFnBuilder, ServerFnCtx, ServerFnMiddleware } from "./fn.js";

export interface RenderResult {
  /** Rendered markup for the app container. */
  html: string;
  /** False when no route matched the URL. */
  matched: boolean;
}

const GLOBALS = ["window", "document", "location", "history"] as const;

let queue: Promise<unknown> = Promise.resolve();

/** Render the router for `url` (path + search) to an HTML string. */
export function renderToString(routes: RouteDefinition[], url: string): Promise<RenderResult> {
  const result = queue.then(() => renderNow(routes, url));
  // Keep the queue alive even when a render fails.
  queue = result.catch(() => {});
  return result;
}

async function renderNow(routes: RouteDefinition[], url: string): Promise<RenderResult> {
  const window = new Window({ url: new URL(url, "http://ssr.local").href });
  const globals = globalThis as Record<string, unknown>;
  const win = window as unknown as Record<string, unknown>;
  const previous = GLOBALS.map((name) => [name, globals[name]] as const);
  const hadListeners = "addEventListener" in globals;
  const prevAdd = globals.addEventListener;
  const prevRemove = globals.removeEventListener;

  for (const name of GLOBALS) globals[name] = win[name];
  globals.window = window;
  globals.addEventListener = window.addEventListener.bind(window);
  globals.removeEventListener = window.removeEventListener.bind(window);

  try {
    const router = createRouter({ routes });
    const target = window.document.createElement("div");
    const dispose = mount(router.view, target as unknown as Element);
    await settle(target as unknown as Element);
    const html = target.innerHTML;
    const matched = router.current() != null;
    dispose();
    router.dispose();
    return { html, matched };
  } finally {
    for (const [name, value] of previous) globals[name] = value;
    if (hadListeners) {
      globals.addEventListener = prevAdd;
      globals.removeEventListener = prevRemove;
    } else {
      delete globals.addEventListener;
      delete globals.removeEventListener;
    }
    window.close();
  }
}

/**
 * Route chunks and async components resolve over microtasks/macrotasks —
 * wait until the rendered markup is stable for two consecutive ticks.
 */
async function settle(target: Element): Promise<void> {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const hasContent = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "").trim() !== "";
  let previous = "";
  let stable = 0;
  for (let i = 0; i < 200 && stable < 2; i++) {
    await tick();
    const current = target.innerHTML;
    if (current === previous && hasContent(current)) stable += 1;
    else stable = 0;
    previous = current;
  }
}

/* ------------------------------------------------------------------ */
/* Node server                                                         */
/* ------------------------------------------------------------------ */

export interface SsrServerOptions {
  /** Project root (with dist/). Defaults to process.cwd(). */
  root?: string;
  /** Defaults to 3000. */
  port?: number;
  /** Server entry exporting `render(url)`. Defaults to `/src/entry-server.ts`. */
  entry?: string;
  /**
   * HTTP server preset: `"bun"` uses native `Bun.serve()`, `"node"` uses
   * `node:http`. Defaults to auto-detect (`Bun.serve` when running on bun).
   */
  preset?: "auto" | "node" | "bun";
}

/** Context passed to API route handlers. */
export interface ApiContext {
  params: Record<string, string>;
}

/** An API route handler: `export function GET(request, { params }) { ... }`. */
export type ApiHandler = (request: Request, context: ApiContext) => Response | Promise<Response>;

interface ServerEntry {
  render(url: string): Promise<RenderResult>;
  /** Re-exported from `virtual:cooked-api-routes` by the server entry. */
  apiRoutes?: RouteDefinition[];
  /** Re-exported from `virtual:cooked-server-fns` by the server entry. */
  serverFns?: Record<string, () => Promise<Record<string, unknown>>>;
}

const SSR_OUTLET = "<!--ssr-outlet-->";

export interface RequestHandlerOptions {
  /** Load the server entry (fresh in dev, cached in prod). */
  loadEntry(): Promise<ServerEntry>;
  /** The HTML shell for a URL (must contain `<!--ssr-outlet-->`). */
  template(url: string): Promise<string>;
}

/**
 * Web-standard request pipeline: server-function RPC, API routes, then SSR
 * HTML. `Request` in, `Response` out — plugs straight into `Bun.serve()` or
 * any fetch-style runtime.
 */
export function createFetchHandler(
  options: RequestHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURI(url.pathname);
    const target = pathname + url.search;
    const entry = await options.loadEntry();

    // Server function RPC endpoint.
    if (pathname.startsWith(SERVER_FN_ENDPOINT)) {
      return serverFnResponse(request, entry, pathname);
    }

    // API routes: any `.ts`/`.js` under src/routes exporting method handlers.
    if (entry.apiRoutes?.length) {
      const match = matchRoutes(entry.apiRoutes, pathname);
      if (match) {
        const mod = await match.route.load();
        const method = request.method.toUpperCase();
        const handler = (mod[method] ?? (method === "HEAD" ? mod.GET : undefined)) as
          | ApiHandler
          | undefined;
        if (!handler) {
          return new Response("Method not allowed", {
            status: 405,
            headers: {
              Allow: Object.keys(mod)
                .filter((k) => /^[A-Z]+$/.test(k))
                .join(", "),
            },
          });
        }
        return handler(request, { params: match.params });
      }
    }

    const result = await entry.render(target);
    const page = (await options.template(target)).replace(SSR_OUTLET, result.html);
    return new Response(page, {
      status: result.matched ? 200 : 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
}

/**
 * Node req/res adapter over `createFetchHandler`. Used by the Vite plugin's
 * dev middleware and the node preset of `createSsrServer`.
 */
export function createRequestHandler(
  options: RequestHandlerOptions,
): (req: any, res: any) => Promise<void> {
  const handle = createFetchHandler(options);
  return async (req, res) => {
    const response = await handle(toWebRequest(req));
    await writeResponse(res, response);
  };
}

/**
 * Production SSR server (dev uses plain `vite` — the plugin serves SSR there).
 * Serves `dist/client` statically and renders through the built
 * `dist/server` entry. Presets: native `Bun.serve()` on bun, `node:http` on
 * node — auto-detected, or forced via `preset`.
 */
export async function createSsrServer(options: SsrServerOptions = {}) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const root = options.root ?? process.cwd();
  const port = options.port ?? 3000;
  const entryPath = options.entry ?? "/src/entry-server.ts";
  const bun = (globalThis as { Bun?: any }).Bun;
  const preset =
    !options.preset || options.preset === "auto" ? (bun ? "bun" : "node") : options.preset;

  const template = fs.readFileSync(path.join(root, "dist/client/index.html"), "utf8");
  const built = path.join(
    root,
    "dist/server",
    entryPath.split("/").pop()!.replace(/\.(ts|mts)$/, ".js"),
  );
  const entry = (await import(pathToFileURL(built).href)) as ServerEntry;
  const clientDir = path.join(root, "dist/client");

  const handlerOptions: RequestHandlerOptions = {
    loadEntry: async () => entry,
    template: async () => template,
  };

  if (preset === "bun") {
    if (!bun) throw new Error('@cookedjs/cooked/server: preset "bun" requires running under bun');
    const handle = createFetchHandler(handlerOptions);
    const server = bun.serve({
      port,
      async fetch(request: Request) {
        const pathname = decodeURIComponent(new URL(request.url).pathname);
        const filePath = path.join(clientDir, pathname);
        // Keep lookups inside the client dist dir.
        if (pathname !== "/" && filePath.startsWith(clientDir)) {
          const file = bun.file(filePath);
          if (await file.exists()) return new Response(file);
        }
        try {
          return await handle(request);
        } catch (error) {
          console.error("[cooked-ssr]", error);
          return new Response("Internal server error", { status: 500 });
        }
      },
    });
    console.log(`cooked ssr server (bun): http://localhost:${port}`);
    return server;
  }

  const { createServer } = await import("node:http");
  const handle = createRequestHandler(handlerOptions);
  const server = createServer((req, res) => {
    serveStatic(fs, path, clientDir, req, res, () => {
      handle(req, res).catch((error) => {
        console.error("[cooked-ssr]", error);
        res.statusCode = 500;
        res.end("Internal server error");
      });
    });
  });

  server.listen(port, () => {
    console.log(`cooked ssr server (node): http://localhost:${port}`);
  });
  return server;
}

const SERVER_FN_ENDPOINT = "/_cooked/fn/";

interface BrandedServerFn {
  __cookedServerFn: true;
  __run(input: unknown, request?: Request): Promise<unknown>;
}

/**
 * Dispatch a server-function call: POST-only, same-origin checked, JSON-only,
 * and only brand-checked functions from plugin-discovered modules run.
 */
async function serverFnResponse(
  request: Request,
  entry: ServerEntry,
  pathname: string,
): Promise<Response> {
  const reject = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (request.method.toUpperCase() !== "POST") {
    return reject(405, "Server functions are POST-only");
  }
  // CSRF guard: cross-site browser requests are refused.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    return reject(403, "Cross-site request refused");
  }
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return reject(403, "Cross-origin request refused");
      }
    } catch {
      return reject(403, "Invalid origin");
    }
  }
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return reject(415, "Expected application/json");
  }

  const id = decodeURIComponent(pathname.slice(SERVER_FN_ENDPOINT.length));
  const hash = id.indexOf("#");
  const file = hash === -1 ? "" : id.slice(0, hash);
  const name = hash === -1 ? "" : id.slice(hash + 1);
  const loader = entry.serverFns?.[file];
  if (!loader || !name) {
    return reject(404, "Unknown server function");
  }
  const mod = await loader();
  const candidate: unknown = mod[name];
  if (
    typeof candidate !== "function" ||
    (candidate as unknown as { __cookedServerFn?: unknown }).__cookedServerFn !== true
  ) {
    return reject(404, "Unknown server function");
  }
  const fn = candidate as unknown as BrandedServerFn;

  let payload: { input?: unknown };
  try {
    payload = (await request.json()) as { input?: unknown };
  } catch {
    return reject(400, "Invalid JSON body");
  }

  try {
    const result = await fn.__run(payload?.input, request);
    return new Response(JSON.stringify({ result: result ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const status =
      (error as { name?: string; status?: unknown })?.name === "ServerFnError" &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    if (status === 500) {
      console.error("[cooked-ssr] server fn error:", error);
      return reject(500, "Internal server error");
    }
    return reject(status, (error as Error).message);
  }
}

/** Node IncomingMessage -> web Request (body streamed for non-GET/HEAD). */
function toWebRequest(req: any): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  const init: RequestInit & { duplex?: string } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = nodeStreamToWeb(req);
    init.duplex = "half";
  }
  return new Request(url.href, init);
}

function nodeStreamToWeb(stream: any): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk: Uint8Array) => controller.enqueue(new Uint8Array(chunk)));
      stream.on("end", () => controller.close());
      stream.on("error", (error: Error) => controller.error(error));
    },
  });
}

/** Write a web Response to a node ServerResponse. */
async function writeResponse(res: any, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function serveStatic(
  fs: typeof import("node:fs"),
  path: typeof import("node:path"),
  dir: string,
  req: any,
  res: any,
  next: () => void,
): void {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = path.join(dir, pathname);
  // Keep lookups inside the client dist dir.
  if (!file.startsWith(dir) || pathname === "/" || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    next();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}
