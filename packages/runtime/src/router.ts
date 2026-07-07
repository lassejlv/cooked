/**
 * File-based, type-safe client router for Cooked — inspired by TanStack Router.
 *
 * The Vite plugin scans `src/routes/**` and provides the route table through
 * the `virtual:cooked-routes` module, plus a generated declaration file that
 * augments the `Register` interface below. Once registered, `navigate`, `Link`
 * and `useParams` know every path and its params at the type level.
 *
 * Route file conventions (mirrors TanStack):
 *   src/routes/index.ck          -> /
 *   src/routes/about.ck          -> /about
 *   src/routes/posts/index.ck    -> /posts
 *   src/routes/posts/$id.ck      -> /posts/$id   (params: { id })
 *   src/routes/docs/$.ck         -> /docs/$      (params: { splat })
 *   src/routes/__layout.ck       -> layout wrapping every route in its dir tree
 */

import { batch, createRoot, effect, memo, onCleanup, signal, untrack } from "./reactive.js";
import { append, setAttr } from "./dom.js";

type Component = (props: Record<string, unknown>) => Node | PromiseLike<Node>;
type RouteModule = Record<string, unknown>;

export interface RouteDefinition {
  /** Route pattern, e.g. `/posts/$id`. */
  path: string;
  /** Lazy import of the compiled `.ck` route module. */
  load: () => Promise<RouteModule>;
  /** Lazy imports of `__layout.ck` modules, outermost first. */
  layouts?: Array<() => Promise<RouteModule>>;
}

/* ------------------------------------------------------------------ */
/* Type-level registration (augmented by vite-plugin-cooked codegen)  */
/* ------------------------------------------------------------------ */

/**
 * Augmented by the generated `cooked-routes.d.ts`:
 *
 *   declare module "cooked/router" {
 *     interface Register {
 *       routes: {
 *         "/": { params: Record<string, never> };
 *         "/posts/$id": { params: { id: string } };
 *       };
 *     }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

type AnyRouteTypes = Record<string, { params: Record<string, string> }>;
type RegisteredRoutes = Register extends { routes: infer R extends AnyRouteTypes }
  ? R
  : AnyRouteTypes;

export type RoutePath = keyof RegisteredRoutes & string;
export type RouteParams<P extends RoutePath> = RegisteredRoutes[P]["params"];

export interface NavigateOptions {
  search?: Record<string, string>;
  replace?: boolean;
}

/** Params are required exactly when the route pattern declares them. */
type NavigateArgs<P extends RoutePath> = string extends RoutePath
  ? [options?: NavigateOptions & { params?: Record<string, string> }]
  : RouteParams<P> extends Record<string, never>
    ? [options?: NavigateOptions & { params?: Record<string, never> }]
    : [options: NavigateOptions & { params: RouteParams<P> }];

export type LinkProps<P extends RoutePath> = {
  to: P;
  search?: Record<string, string>;
  replace?: boolean;
  class?: string;
  children?: unknown;
} & (string extends RoutePath
  ? { params?: Record<string, string> }
  : RouteParams<P> extends Record<string, never>
    ? { params?: Record<string, never> }
    : { params: RouteParams<P> });

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

interface Segment {
  kind: "static" | "param" | "splat";
  value: string; // literal text or param name
}

interface CompiledRoute {
  definition: RouteDefinition;
  segments: Segment[];
}

interface Match {
  route: CompiledRoute;
  params: Record<string, string>;
}

function parsePattern(path: string): Segment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => {
      if (part === "$") return { kind: "splat" as const, value: "splat" };
      if (part.startsWith("$")) return { kind: "param" as const, value: part.slice(1) };
      return { kind: "static" as const, value: part };
    });
}

/** Higher score = higher match priority. Static beats param beats splat. */
function scoreOf(segments: Segment[]): number[] {
  const score: number[] = segments.map((s) =>
    s.kind === "static" ? 3 : s.kind === "param" ? 2 : 1,
  );
  // Longer, more specific patterns win ties on shared prefixes.
  score.push(0);
  return score;
}

function compareScore(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compileRoutes(definitions: RouteDefinition[]): CompiledRoute[] {
  return definitions
    .map((definition) => ({ definition, segments: parsePattern(definition.path) }))
    .sort((a, b) => compareScore(scoreOf(a.segments), scoreOf(b.segments)));
}

function matchRoute(routes: CompiledRoute[], pathname: string): Match | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  outer: for (const route of routes) {
    const params: Record<string, string> = {};
    const segs = route.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.kind === "splat") {
        params[seg.value] = parts.slice(i).join("/");
        return { route, params };
      }
      const part = parts[i];
      if (part === undefined) continue outer;
      if (seg.kind === "static") {
        if (seg.value !== part) continue outer;
      } else {
        params[seg.value] = part;
      }
    }
    if (parts.length !== segs.length) continue outer;
    return { route, params };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Router state                                                        */
/* ------------------------------------------------------------------ */

interface RouterState {
  pathname: { get(): string; set(v: string): void };
  search: { get(): string; set(v: string): void };
  params: { get(): Record<string, string>; set(v: Record<string, string>): void };
  routes: CompiledRoute[];
  base: string;
  notFound?: Component;
}

let active: RouterState | null = null;

function requireRouter(): RouterState {
  if (!active) throw new Error("cooked/router: no router created — call createRouter() first");
  return active;
}

function stripBase(pathname: string, base: string): string {
  if (base !== "/" && pathname.startsWith(base)) {
    const rest = pathname.slice(base.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return pathname;
}

export function buildHref(
  to: string,
  params?: Record<string, string>,
  search?: Record<string, string>,
): string {
  const path = to
    .split("/")
    .map((part) => {
      if (part === "$") return params?.splat ?? "";
      if (part.startsWith("$")) {
        const name = part.slice(1);
        const value = params?.[name];
        if (value === undefined) {
          throw new Error(`cooked/router: missing param "${name}" for "${to}"`);
        }
        return encodeURIComponent(value);
      }
      return part;
    })
    .join("/");
  const query = search ? new URLSearchParams(search).toString() : "";
  const base = active?.base ?? "/";
  const full = base === "/" ? path : base.replace(/\/$/, "") + path;
  return (full || "/") + (query ? `?${query}` : "");
}

function syncFromLocation(state: RouterState): void {
  batch(() => {
    state.pathname.set(stripBase(location.pathname, state.base));
    state.search.set(location.search);
  });
}

/** Navigate to a registered route. Params are type-checked against the pattern. */
export function navigate<P extends RoutePath>(to: P, ...args: NavigateArgs<P>): void {
  const state = requireRouter();
  const options = (args[0] ?? {}) as NavigateOptions & { params?: Record<string, string> };
  const href = buildHref(to, options.params, options.search);
  if (options.replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  syncFromLocation(state);
}

/** Reactive accessor for the current route params. */
export function useParams<P extends RoutePath = RoutePath>(): { get(): RouteParams<P> } {
  const state = requireRouter();
  return { get: () => state.params.get() as RouteParams<P> };
}

/** Reactive accessor for the current search params. */
export function useSearch(): { get(): Record<string, string> } {
  const state = requireRouter();
  return {
    get: () => Object.fromEntries(new URLSearchParams(state.search.get())),
  };
}

/** Reactive accessor for the current pathname (base stripped). */
export function usePathname(): { get(): string } {
  const state = requireRouter();
  return { get: () => state.pathname.get() };
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

function pickComponent(mod: RouteModule, file: string): Component {
  if (typeof mod.default === "function") return mod.default as Component;
  const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
  if (fns.length === 1) return fns[0][1] as Component;
  throw new Error(
    `cooked/router: route module "${file}" must have a default export or exactly one exported component (found ${fns.length})`,
  );
}

/**
 * Anchor that navigates client-side. `to`/`params` are type-checked against
 * the generated route registry.
 */
export function Link<P extends RoutePath>(props: LinkProps<P>): Node {
  const p = props as Record<string, unknown>;
  const el = document.createElement("a");
  setAttr(el, "href", () =>
    buildHref(
      String(p.to),
      p.params as Record<string, string> | undefined,
      p.search as Record<string, string> | undefined,
    ),
  );
  setAttr(el, "class", () => p.class);
  el.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (el.target && el.target !== "_self") return;
    event.preventDefault();
    const state = requireRouter();
    const href = el.getAttribute("href") ?? "/";
    if (p.replace) history.replaceState(null, "", href);
    else history.pushState(null, "", href);
    syncFromLocation(state);
  });
  append(el, (p.children ?? null) as Node | null);
  return el;
}

export interface Router {
  /** Component rendering the matched route (wrapped in its layouts). Pass to `mount`. */
  view: Component;
  navigate: typeof navigate;
  /** Remove the popstate listener and detach the router. */
  dispose(): void;
}

export interface RouterOptions {
  routes: RouteDefinition[];
  /** App base path, e.g. `/app`. Defaults to `/`. */
  base?: string;
  /** Rendered when no route matches. */
  notFound?: Component;
}

/** Create the app router. One router is active at a time. */
export function createRouter(options: RouterOptions): Router {
  const base = options.base?.replace(/\/$/, "") || "/";
  const state: RouterState = {
    pathname: signal(stripBase(location.pathname, base)),
    search: signal(location.search),
    params: signal<Record<string, string>>({}),
    routes: compileRoutes(options.routes),
    base,
    notFound: options.notFound,
  };
  active = state;

  const onPopState = () => syncFromLocation(state);
  addEventListener("popstate", onPopState);

  const matched = memo<Match | null>(() => matchRoute(state.routes, state.pathname.get()));

  const view: Component = () => {
    const frag = document.createDocumentFragment();
    const marker = document.createComment("cooked-router");
    frag.appendChild(marker);

    let disposePrev = () => {};
    let nodes: Node[] = [];
    let token = 0;

    const clear = () => {
      disposePrev();
      disposePrev = () => {};
      for (const node of nodes) node.parentNode?.removeChild(node);
      nodes = [];
    };

    // Runs when the owner that mounted the view is disposed (unmount).
    onCleanup(() => {
      token++;
      clear();
    });

    const show = (t: number, node: Node) => {
      if (t !== token) return;
      const host = marker.parentNode ?? frag;
      const added =
        node.nodeType === 11 /* fragment */ ? [...node.childNodes] : [node];
      host.insertBefore(node, marker);
      nodes = added;
    };

    effect(() => {
      const m = matched.get();
      const t = ++token;
      untrack(() => state.params.set(m?.params ?? {}));

      if (!m) {
        clear();
        const notFound = state.notFound;
        if (notFound) {
          createRoot((dispose) => {
            disposePrev = dispose;
            const node = notFound({});
            if (isThenable(node)) void node.then((n) => show(t, n));
            else show(t, node);
          });
        } else {
          show(t, document.createTextNode("Not found"));
        }
        return;
      }

      const loaders = [...(m.route.definition.layouts ?? []), m.route.definition.load];
      const loaded = Promise.all(loaders.map((load) => load()));
      loaded.catch((error) => {
        console.error(`cooked/router: failed to load route "${m.route.definition.path}"`, error);
      });
      void loaded.then((mods) => {
        if (t !== token) return;
        clear();
        createRoot((dispose) => {
          disposePrev = dispose;
          const leaf = pickComponent(mods[mods.length - 1], m.route.definition.path);
          let node = leaf({ params: m.params });
          for (let i = mods.length - 2; i >= 0; i--) {
            const layout = pickComponent(mods[i], `layout of ${m.route.definition.path}`);
            node = layout({ children: node });
          }
          if (isThenable(node)) void node.then((n) => show(t, n));
          else show(t, node);
        });
      });
    });

    return frag;
  };

  return {
    view,
    navigate,
    dispose() {
      removeEventListener("popstate", onPopState);
      if (active === state) active = null;
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<Node> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
