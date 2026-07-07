import { compile } from "@cooked/binding";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { routesDeclaration, routesModule, scanRoutes } from "./routes.js";

const CK_RE = /\.ck$/;
const ROUTES_VIRTUAL_ID = "virtual:cooked-routes";
const ROUTES_RESOLVED_ID = "\0cooked-routes";

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
        if (!file.startsWith(routesDir) || !CK_RE.test(file)) return;
        await emitRouteTypes();
        const mod = server.moduleGraph.getModuleById(ROUTES_RESOLVED_ID);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: "full-reload" });
        }
      };
      server.watcher.on("add", refresh);
      server.watcher.on("unlink", refresh);
    },

    resolveId(id) {
      if (id === ROUTES_VIRTUAL_ID) return ROUTES_RESOLVED_ID;
      return null;
    },

    load(id) {
      if (id === ROUTES_RESOLVED_ID) {
        const entries = existsSync(routesDir) ? scanRoutes(routesDir) : [];
        return routesModule(entries);
      }
      return null;
    },

    async transform(code, id) {
      if (!filter.test(id)) return null;

      const result = compile(code, id);
      if (result.errors.length > 0) {
        this.error(`[cooked] ${id}\n  ${result.errors.join("\n  ")}`);
      }
      if (emitDeclarations && result.declarations) {
        await writeDeclaration(root, declarationsDir, id, result.declarations);
      }

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },

  };
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
