/**
 * File-based routing support: scans `.ck` files under `src/routes`, feeds the route
 * table to the app through the `virtual:cooked-routes` module, and generates
 * a declaration file that registers every path (and its params) with
 * `@cookedjs/cooked/router` for type-safe `Link`/`navigate`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface RouteEntry {
  /** Route pattern, e.g. `/posts/$id`. */
  pattern: string;
  /** Absolute path of the `.ck` route file. */
  file: string;
  /** Absolute paths of `__layout.ck` files wrapping it, outermost first. */
  layouts: string[];
}

const LAYOUT_FILE = "__layout.ck";
const API_RE = /\.(ts|js)$/;

/** Scan a routes directory into route entries. Returns [] if the dir is absent. */
export function scanRoutes(routesDir: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  walk(routesDir, routesDir, [], entries);
  return entries.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/**
 * Scan for API routes: `.ts`/`.js` files under the routes dir. Each exports
 * HTTP method handlers (`GET`, `POST`, ...) taking a web `Request`.
 */
export function scanApiRoutes(routesDir: string): Array<{ pattern: string; file: string }> {
  const out: Array<{ pattern: string; file: string }> = [];
  walkApi(routesDir, routesDir, out);
  return out.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

function walkApi(routesDir: string, dir: string, out: Array<{ pattern: string; file: string }>): void {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      walkApi(routesDir, full, out);
      continue;
    }
    if (!item.isFile() || !API_RE.test(item.name) || item.name.endsWith(".d.ts")) continue;
    const relDir = relative(routesDir, dir).split("\\").join("/");
    const name = item.name.replace(API_RE, "");
    const segments = relDir === "" ? [] : relDir.split("/");
    if (name !== "index") segments.push(name);
    out.push({ pattern: "/" + segments.join("/"), file: full });
  }
}

/** JS source of the `virtual:cooked-api-routes` module (server-only). */
export function apiRoutesModule(entries: Array<{ pattern: string; file: string }>): string {
  const lines = entries.map(
    (entry) =>
      `  { path: ${JSON.stringify(entry.pattern)}, load: () => import(${JSON.stringify(entry.file)}) },`,
  );
  return `export const apiRoutes = [\n${lines.join("\n")}\n];\n`;
}

const SERVER_FN_RE = /\.server\.(ts|js)$/;
const MODULE_RE = /\.(ts|js|mts|mjs|ck)$/;

/**
 * Find modules that define server functions: every `*.server.ts` plus any
 * `.ts`/`.js` under `dir` that calls `createServerFn`. Returns root-relative ids.
 */
export function scanServerFnFiles(root: string, dir: string): Array<{ id: string; file: string }> {
  const out: Array<{ id: string; file: string }> = [];
  const walk = (current: string) => {
    let items;
    try {
      items = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(current, item.name);
      if (item.isDirectory()) {
        if (item.name !== "node_modules") walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      const isServerFile = SERVER_FN_RE.test(item.name);
      const mayContainFns =
        !isServerFile &&
        MODULE_RE.test(item.name) &&
        !item.name.endsWith(".d.ts") &&
        readFileSync(full, "utf8").includes("createServerFn");
      if (isServerFile || mayContainFns) {
        out.push({ id: relative(root, full).split("\\").join("/"), file: full });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** JS source of the `virtual:cooked-server-fns` manifest (server-only). */
export function serverFnsModule(entries: Array<{ id: string; file: string }>): string {
  const lines = entries.map(
    (entry) => `  ${JSON.stringify(entry.id)}: () => import(${JSON.stringify(entry.file)}),`,
  );
  return `export const serverFns = {\n${lines.join("\n")}\n};\n`;
}

/**
 * Replace a `*.server.ts` module with client RPC stubs — server code must
 * never reach the browser bundle. Recognizes `export const NAME = ...` and
 * `export (async) function NAME`.
 */
export function serverFnClientStub(moduleId: string, code: string): string {
  const names = new Set<string>();
  for (const match of code.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  const lines = [...names].map(
    (name) =>
      `export const ${name} = serverFnClient(${JSON.stringify(`${moduleId}#${name}`)});`,
  );
  return `import { serverFnClient } from "@cookedjs/cooked/fn-client";\n${lines.join("\n")}\n`;
}

export function isServerFnFile(id: string): boolean {
  return SERVER_FN_RE.test(id.split("?", 1)[0]);
}

/**
 * Rewrite `export const NAME = createServerFn()...` declarations (in any
 * module) to RPC stubs for the client bundle, leaving other exports intact.
 * Returns null when the module defines no server functions.
 *
 * Note: unlike `*.server.ts` (whole module replaced), a mixed module's other
 * top-level code still ships to the client — keep server-only imports inside
 * handlers or in `*.server.ts` files.
 */
export function rewriteServerFnExports(moduleId: string, code: string): string | null {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const match of code.matchAll(
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(createServerFn)\b/g,
  )) {
    const name = match[1];
    const start = match.index + match[0].lastIndexOf("createServerFn");
    const end = chainEnd(code, start + "createServerFn".length);
    if (end == null) continue;
    edits.push({
      start,
      end,
      text: `serverFnClient(${JSON.stringify(`${moduleId}#${name}`)})`,
    });
  }
  if (edits.length === 0) return null;
  let out = code;
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return `import { serverFnClient } from "@cookedjs/cooked/fn-client";\n${out}`;
}

/**
 * Given the offset just past a call-chain head (e.g. after `createServerFn`),
 * scan `.prop` / `(...)` links until the chain ends and return the end offset.
 * Tracks strings, template literals, and comments while balancing brackets.
 */
function chainEnd(code: string, from: number): number | null {
  let i = from;
  const skipTrivia = () => {
    for (;;) {
      while (i < code.length && /\s/.test(code[i])) i++;
      if (code.startsWith("//", i)) {
        while (i < code.length && code[i] !== "\n") i++;
      } else if (code.startsWith("/*", i)) {
        const close = code.indexOf("*/", i + 2);
        i = close === -1 ? code.length : close + 2;
      } else {
        return;
      }
    }
  };
  const consumeBalanced = (): boolean => {
    const open = code[i];
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    let depth = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i++;
        while (i < code.length && code[i] !== quote) {
          if (code[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (code.startsWith("//", i)) {
        while (i < code.length && code[i] !== "\n") i++;
        continue;
      }
      if (code.startsWith("/*", i)) {
        const end = code.indexOf("*/", i + 2);
        i = end === -1 ? code.length : end + 2;
        continue;
      }
      if (ch === open || ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === close || ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          return true;
        }
      }
      i++;
    }
    return false;
  };

  for (;;) {
    skipTrivia();
    if (code[i] === "(") {
      if (!consumeBalanced()) return null;
      continue;
    }
    if (code[i] === ".") {
      i++;
      skipTrivia();
      while (i < code.length && /[\w$]/.test(code[i])) i++;
      continue;
    }
    return i;
  }
}

function walk(routesDir: string, dir: string, layouts: string[], out: RouteEntry[]): void {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const layoutFile = items.find((i) => i.isFile() && i.name === LAYOUT_FILE);
  const nextLayouts = layoutFile ? [...layouts, join(dir, LAYOUT_FILE)] : layouts;

  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      walk(routesDir, full, nextLayouts, out);
      continue;
    }
    if (!item.isFile() || !item.name.endsWith(".ck") || item.name === LAYOUT_FILE) continue;

    const relDir = relative(routesDir, dir).split("\\").join("/");
    const name = item.name.slice(0, -".ck".length);
    const segments = relDir === "" ? [] : relDir.split("/");
    if (name !== "index") segments.push(name);
    out.push({
      pattern: "/" + segments.join("/"),
      file: full,
      layouts: nextLayouts,
    });
  }
}

/** JS source of the `virtual:cooked-routes` module. */
export function routesModule(entries: RouteEntry[]): string {
  const lines = entries.map((entry) => {
    const layouts = entry.layouts.map((l) => `() => import(${JSON.stringify(l)})`).join(", ");
    return [
      "  {",
      `    path: ${JSON.stringify(entry.pattern)},`,
      `    load: () => import(${JSON.stringify(entry.file)}),`,
      `    layouts: [${layouts}],`,
      "  },",
    ].join("\n");
  });
  return `export const routes = [\n${lines.join("\n")}\n];\n`;
}

function paramsType(pattern: string): string {
  const params = pattern
    .split("/")
    .filter(Boolean)
    .flatMap((part) => {
      if (part === "$") return ["splat"];
      if (part.startsWith("$")) return [part.slice(1)];
      return [];
    });
  if (params.length === 0) return "Record<string, never>";
  return `{ ${params.map((p) => `${JSON.stringify(p)}: string`).join("; ")} }`;
}

/** Declaration file registering all route paths with `@cookedjs/cooked/router`. */
export function routesDeclaration(entries: RouteEntry[]): string {
  const routes = entries
    .map((e) => `      ${JSON.stringify(e.pattern)}: { params: ${paramsType(e.pattern)} };`)
    .join("\n");
  return [
    "// Generated by vite-plugin-cooked — do not edit.",
    'import "@cookedjs/cooked/router";',
    "",
    'declare module "@cookedjs/cooked/router" {',
    "  interface Register {",
    "    routes: {",
    routes,
    "    };",
    "  }",
    "}",
    "",
  ].join("\n");
}
