import { compile } from "@cookedjs/binding";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import {
  apiRoutesModule,
  isServerFnFile,
  rewriteServerFnExports,
  routesDeclaration,
  routesModule,
  scanApiRoutes,
  scanRoutes,
  scanServerFnFiles,
  serverFnClientStub,
  serverFnsModule,
} from "./routes.js";

const CK_RE = /\.ck$/;
const ROUTES_VIRTUAL_ID = "virtual:cooked-routes";
const ROUTES_RESOLVED_ID = "\0cooked-routes";
const API_ROUTES_VIRTUAL_ID = "virtual:cooked-api-routes";
const API_ROUTES_RESOLVED_ID = "\0cooked-api-routes";
const SERVER_FNS_VIRTUAL_ID = "virtual:cooked-server-fns";
const SERVER_FNS_RESOLVED_ID = "\0cooked-server-fns";

export interface CookedOptions {
  /** Extra file extensions to treat as Cooked sources. */
  include?: RegExp;
  /** Write `.d.ck.ts` files for TypeScript/editor tooling. */
  declarations?: boolean;
  /**
   * Where generated declarations go, relative to the project root.
   * Defaults to `node_modules/.cooked/types` so they stay out of your
   * source tree. Resolve them in tsconfig via:
   *
   *   "rootDirs": [".", "./node_modules/.cooked/types"]
   */
  declarationsDir?: string;
  /**
   * Directory scanned for file-based routes, relative to the project root.
   * Defaults to `src/routes`. Routes are exposed via `virtual:cooked-routes`.
   */
  routesDir?: string;
}

const DEFAULT_DECLARATIONS_DIR = "node_modules/.cooked/types";
const DEFAULT_ROUTES_DIR = "src/routes";

/**
 * Vite plugin: compiles `.ck` files to JS via the native Cooked compiler.
 * Works under both Vite (rollup/esbuild) and rolldown-vite — it only uses the
 * standard `transform` hook.
 */
export default function cooked(options: CookedOptions = {}): Plugin {
  const filter = options.include ?? CK_RE;
  const emitDeclarations = options.declarations ?? true;
  let root = process.cwd();
  let declarationsDir = resolve(root, options.declarationsDir ?? DEFAULT_DECLARATIONS_DIR);
  let routesDir = resolve(root, options.routesDir ?? DEFAULT_ROUTES_DIR);

  const emitRouteTypes = async () => {
    if (!emitDeclarations || !existsSync(routesDir)) return;
    const entries = scanRoutes(routesDir);
    const file = join(declarationsDir, "cooked-routes.d.ts");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, routesDeclaration(entries));
  };

  return {
    name: "vite-plugin-cooked",
    enforce: "pre",

    // Zero-config SSR: when src/entry-server.ts exists, `vite` serves SSR in
    // dev (middleware below) and `vite build` builds client + server bundles.
    config(userConfig, env) {
      const configRoot = resolve(userConfig.root ?? process.cwd());
      const entry = ssrEntry(configRoot);
      if (!entry) return {};
      const overrides: Record<string, unknown> = { appType: "custom" };
      if (env.command === "build") {
        overrides.builder = {};
        overrides.environments = {
          client: { build: { outDir: "dist/client" } },
          ssr: { build: { outDir: "dist/server", rollupOptions: { input: entry } } },
        };
      }
      return overrides;
    },

    configResolved(config) {
      root = config.root;
      declarationsDir = resolve(root, options.declarationsDir ?? DEFAULT_DECLARATIONS_DIR);
      routesDir = resolve(root, options.routesDir ?? DEFAULT_ROUTES_DIR);
    },

    async buildStart() {
      await emitRouteTypes();
    },

    configureServer(server: ViteDevServer) {
      const refresh = async (file: string) => {
        const ids: string[] = [];
        if (file.startsWith(routesDir)) {
          await emitRouteTypes();
          ids.push(ROUTES_RESOLVED_ID, API_ROUTES_RESOLVED_ID);
        }
        // Server functions can live in any src module.
        if (file.startsWith(join(root, "src"))) ids.push(SERVER_FNS_RESOLVED_ID);
        for (const id of ids) {
          const mod = server.moduleGraph.getModuleById(id);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: "full-reload" });
          }
        }
      };
      server.watcher.on("add", refresh);
      server.watcher.on("unlink", refresh);
      server.watcher.on("change", refresh);

      // SSR dev: plain `vite` serves server-rendered HTML, API routes, and
      // server functions when src/entry-server.ts exists.
      const entry = ssrEntry(root);
      if (!entry) return;
      const entryUrl = `/${relative(root, entry).split("\\").join("/")}`;
      return () => {
        server.middlewares.use((req, res, next) => {
          void (async () => {
            const { createRequestHandler } = (await import("@cookedjs/cooked/server")) as {
              createRequestHandler: (opts: {
                loadEntry(): Promise<any>;
                template(url: string): Promise<string>;
              }) => (req: any, res: any) => Promise<void>;
            };
            const handle = createRequestHandler({
              loadEntry: () => server.ssrLoadModule(entryUrl),
              template: (url) =>
                server.transformIndexHtml(
                  url,
                  readFileSync(join(root, "index.html"), "utf8"),
                ),
            });
            await handle(req, res);
          })().catch(next);
        });
      };
    },

    resolveId(id) {
      if (id === ROUTES_VIRTUAL_ID) return ROUTES_RESOLVED_ID;
      if (id === API_ROUTES_VIRTUAL_ID) return API_ROUTES_RESOLVED_ID;
      if (id === SERVER_FNS_VIRTUAL_ID) return SERVER_FNS_RESOLVED_ID;
      return null;
    },

    load(id) {
      if (id === ROUTES_RESOLVED_ID) {
        const entries = existsSync(routesDir) ? scanRoutes(routesDir) : [];
        return routesModule(entries);
      }
      if (id === API_ROUTES_RESOLVED_ID) {
        const entries = existsSync(routesDir) ? scanApiRoutes(routesDir) : [];
        return apiRoutesModule(entries);
      }
      if (id === SERVER_FNS_RESOLVED_ID) {
        return serverFnsModule(scanServerFnFiles(root, join(root, "src")));
      }
      return null;
    },

    async transform(code, id, transformOptions) {
      const clean = id.split("?", 1)[0];
      const inRoot = clean.startsWith(root);

      if (!transformOptions?.ssr && inRoot) {
        // Client builds must not ship server-function code:
        // *.server.ts modules are replaced entirely with RPC stubs...
        if (isServerFnFile(id)) {
          const moduleId = relative(root, clean).split("\\").join("/");
          return { code: serverFnClientStub(moduleId, code), map: null };
        }
        // ...and `createServerFn` exports in ANY other module are rewritten
        // in place (the rest of the module stays). `.ck` files are handled
        // after compilation below.
        if (!filter.test(id) && code.includes("createServerFn")) {
          const moduleId = relative(root, clean).split("\\").join("/");
          const rewritten = rewriteServerFnExports(moduleId, code);
          if (rewritten) return { code: rewritten, map: null };
        }
      }

      // The server entry gets the api-route and server-fn manifests injected —
      // users never re-export the virtual modules themselves.
      if (transformOptions?.ssr && inRoot && /entry-server\.(ts|js|mts|mjs)$/.test(clean)) {
        let augmented = code;
        if (!code.includes("virtual:cooked-api-routes")) {
          augmented += `\nexport { apiRoutes } from "virtual:cooked-api-routes";`;
        }
        if (!code.includes("virtual:cooked-server-fns")) {
          augmented += `\nexport { serverFns } from "virtual:cooked-server-fns";`;
        }
        if (augmented !== code) return { code: augmented, map: null };
      }

      if (!filter.test(id)) return null;

      const result = compile(code, id);
      if (result.errors.length > 0) {
        this.error(`[cooked] ${id}\n  ${result.errors.join("\n  ")}`);
      }
      if (emitDeclarations && result.declarations) {
        await writeDeclaration(root, declarationsDir, id, result.declarations);
      }

      // Server functions defined in .ck files: stub them out of client builds
      // (the compiled module keeps the `export const x = createServerFn()...`).
      if (!transformOptions?.ssr && inRoot && result.code.includes("createServerFn")) {
        const moduleId = relative(root, clean).split("\\").join("/");
        const rewritten = rewriteServerFnExports(moduleId, result.code);
        if (rewritten) return { code: rewritten, map: null };
      }

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },

  };
}

/** The SSR entry module path when the project has one. */
function ssrEntry(root: string): string | null {
  for (const candidate of ["src/entry-server.ts", "src/entry-server.js"]) {
    const full = join(root, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

async function writeDeclaration(
  root: string,
  declarationsDir: string,
  id: string,
  declarations: string,
): Promise<void> {
  const file = declarationPath(root, declarationsDir, id);
  if (!file) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, declarations);
}

function declarationPath(root: string, declarationsDir: string, id: string): string | null {
  const clean = id.split("?", 1)[0];
  const rel = relative(root, clean);
  // Files outside the project root (or inside node_modules) can't be mirrored
  // into the types dir in a way tsconfig `rootDirs` would resolve — skip them.
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes("node_modules")) {
    return null;
  }
  return join(declarationsDir, rel.replace(/\.ck$/, ".d.ck.ts"));
}
