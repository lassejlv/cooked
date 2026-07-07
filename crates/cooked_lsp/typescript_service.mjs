/**
 * Persistent TypeScript service for the Cooked LSP.
 *
 * Runs as a long-lived child process speaking NDJSON over stdio: one JSON
 * request per line in, one JSON response per line out. The TypeScript
 * LanguageService (and its parsed ASTs / lib typings) stay warm between
 * requests, so everything after the first request is fast.
 *
 * Cooked syntax is converted to virtual TSX with a per-line column mapping,
 * so positions translate exactly in both directions:
 *   fn            -> function
 *   let mut x     -> let x
 *   let d => expr -> const d = expr
 *   effect { .. } -> effect(() => { .. })
 */

import ts from "typescript";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = "cooked-env.d.ts";

/** fileName -> { ckText, tsxText, version, mapping } (editor buffers) */
const files = new Map();
/** on-disk `.ck` imports, converted on demand: fileName -> { key, tsxText, mapping } */
const diskCache = new Map();
/** directory -> project root (nearest ancestor with package.json), null when none */
const rootCache = new Map();

const options = {
  allowJs: false,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  strict: true,
  // Cooked types are optional — don't flag every untyped prop.
  noImplicitAny: false,
  target: ts.ScriptTarget.ES2022,
  types: [],
};

/** `/abs/path/Foo.ck.tsx` -> `/abs/path/Foo.ck` when the `.ck` exists on disk. */
function diskCkPath(name) {
  if (!name.endsWith(".ck.tsx")) return null;
  const ck = name.slice(0, -".tsx".length);
  return ts.sys.fileExists(ck) ? ck : null;
}

function diskSnapshot(name) {
  const ck = diskCkPath(name);
  if (!ck) return null;
  const text = ts.sys.readFile(ck);
  if (text == null) return null;
  const cached = diskCache.get(name);
  if (cached && cached.key === text) return cached;
  const { tsxText, mapping } = cookedToTsx(text);
  const entry = { key: text, tsxText, mapping };
  diskCache.set(name, entry);
  return entry;
}

function projectRoot(dir) {
  if (rootCache.has(dir)) return rootCache.get(dir);
  let root = null;
  let current = dir;
  while (true) {
    if (ts.sys.fileExists(path.join(current, "package.json"))) {
      root = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  rootCache.set(dir, root);
  return root;
}

/**
 * Generated declarations for the open files' projects — most importantly
 * `cooked-routes.d.ts`, whose `Register` augmentation makes `Link`/`navigate`
 * paths and params type-checked in the editor.
 */
function generatedDeclarations() {
  const found = [];
  for (const name of files.keys()) {
    const root = projectRoot(path.dirname(name));
    if (!root) continue;
    const registry = path.join(root, "node_modules", ".cooked", "types", "cooked-routes.d.ts");
    if (ts.sys.fileExists(registry) && !found.includes(registry)) found.push(registry);
  }
  return found;
}

const host = {
  getCompilationSettings: () => options,
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
  getScriptFileNames: () => [...files.keys(), ...generatedDeclarations(), ENV_FILE],
  getScriptVersion(name) {
    if (name === ENV_FILE) return "0";
    const file = files.get(name);
    if (file) return String(file.version);
    const ck = diskCkPath(name);
    if (ck) return String(ts.sys.getModifiedTime?.(ck)?.getTime() ?? 0);
    // Disk files (e.g. the generated route registry) re-read when they change.
    return String(ts.sys.getModifiedTime?.(name)?.getTime() ?? 0);
  },
  getScriptSnapshot(name) {
    if (name === ENV_FILE) return ts.ScriptSnapshot.fromString(cookedEnv());
    const file = files.get(name);
    if (file) return ts.ScriptSnapshot.fromString(file.tsxText);
    const disk = diskSnapshot(name);
    if (disk) return ts.ScriptSnapshot.fromString(disk.tsxText);
    if (ts.sys.fileExists(name)) {
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? "");
    }
    return undefined;
  },
  fileExists: (name) =>
    name === ENV_FILE || files.has(name) || diskCkPath(name) != null || ts.sys.fileExists(name),
  readFile: (name) =>
    name === ENV_FILE
      ? cookedEnv()
      : (files.get(name)?.tsxText ?? diskSnapshot(name)?.tsxText ?? ts.sys.readFile(name)),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  resolveModuleNames(moduleNames, containingFile) {
    return moduleNames.map((name) => {
      // `import { X } from "./X.ck"` -> the on-demand converted virtual TSX.
      if (name.endsWith(".ck")) {
        const base = path.resolve(path.dirname(containingFile), name);
        if (ts.sys.fileExists(base)) {
          return { resolvedFileName: `${base}.tsx`, extension: ".tsx" };
        }
        return undefined;
      }
      return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
    });
  },
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let response;
  try {
    response = handle(JSON.parse(line));
  } catch (error) {
    response = { ok: false, error: String(error && error.stack ? error.stack : error) };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
rl.on("close", () => process.exit(0));

function handle(input) {
  if (input.action === "ping") return { ok: true };

  const fileName = `${toFilePath(input.fileName ?? "") ?? "/virtual/App.ck"}.tsx`;
  const file = upsert(fileName, input.text ?? "");
  const position = input.position ?? { line: 0, character: 0 };
  const offset = offsetAt(
    file.tsxText,
    position.line,
    ckToTsxCol(file.mapping[position.line] ?? [], position.character),
  );

  switch (input.action) {
    case "completion":
      return completion(fileName, offset, input.triggerCharacter);
    case "hover":
      return hover(fileName, file, offset);
    case "definition":
      return definition(fileName, file, offset);
    case "diagnostics":
      return diagnostics(fileName, file);
    default:
      return { ok: false, error: `Unknown action ${input.action}` };
  }
}

function upsert(fileName, ckText) {
  const existing = files.get(fileName);
  if (existing && existing.ckText === ckText) return existing;
  const { tsxText, mapping } = cookedToTsx(ckText);
  const file = {
    ckText,
    tsxText,
    mapping,
    version: (existing?.version ?? 0) + 1,
  };
  files.set(fileName, file);
  return file;
}

function completion(fileName, offset, triggerCharacter) {
  const result = service.getCompletionsAtPosition(fileName, offset, {
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
    includeInsertTextCompletions: true,
    triggerCharacter,
  });
  return {
    ok: true,
    items: (result?.entries ?? []).slice(0, 80).map((entry) => ({
      label: entry.name,
      kind: entry.kind,
      detail: entry.source ? `TypeScript from ${entry.source}` : "TypeScript",
      insertText: entry.insertText,
    })),
  };
}

function hover(fileName, file, offset) {
  const info = service.getQuickInfoAtPosition(fileName, offset);
  if (!info) return { ok: true };
  const display = ts.displayPartsToString(info.displayParts ?? []);
  const docs = ts.displayPartsToString(info.documentation ?? []);
  return {
    ok: true,
    text: [display, docs].filter(Boolean).join("\n\n"),
    span: span(file, info.textSpan),
  };
}

function definition(fileName, file, offset) {
  const defs = service.getDefinitionAtPosition(fileName, offset) ?? [];
  return {
    ok: true,
    definitions: defs
      .filter((def) => def.fileName === fileName)
      .map((def) => ({ span: span(file, def.textSpan) })),
  };
}

function diagnostics(fileName, file) {
  const all = [
    ...service.getSyntacticDiagnostics(fileName),
    ...service.getSemanticDiagnostics(fileName),
    ...service.getSuggestionDiagnostics(fileName),
  ];
  return {
    ok: true,
    diagnostics: all.map((diag) => ({
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      category: ts.DiagnosticCategory[diag.category],
      code: diag.code,
      span: span(file, { start: diag.start ?? 0, length: diag.length ?? 1 }),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Cooked -> TSX conversion with per-line column mapping               */
/* ------------------------------------------------------------------ */

/**
 * All conversions are intra-line, so line numbers are identical between the
 * `.ck` source and the virtual TSX. Each line carries a sorted list of edits
 * `{ col, len, text }` (in `.ck` coordinates) used to translate columns.
 */
function cookedToTsx(source) {
  const lines = source.split("\n");
  const edits = lines.map(() => []);

  // effect { ... } -> effect(() => { ... }): needs cross-line brace matching.
  for (const match of source.matchAll(/\beffect\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const openPos = positionAt(source, open);
    edits[openPos.line].push({ col: openPos.character, len: 1, text: "(() => {" });
    const close = matchingBrace(source, open);
    if (close != null) {
      const closePos = positionAt(source, close);
      edits[closePos.line].push({ col: closePos.character, len: 1, text: "})" });
    }
  }

  lines.forEach((line, i) => {
    for (const match of line.matchAll(/\bfn\b/g)) {
      edits[i].push({ col: match.index, len: 2, text: "function" });
    }
    // Components (capitalized, single-line signature): individual Cooked params
    // become a destructured props object so TSX call sites type-check.
    for (const match of line.matchAll(/\bfn\s+([A-Z][\w$]*)\s*\(([^)]*)\)/g)) {
      const params = componentProps(match[2]);
      if (params) {
        const start = match.index + match[0].indexOf("(") + 1;
        edits[i].push({ col: start, len: match[2].length, text: params });
      }
    }
    for (const match of line.matchAll(/\blet(\s+)mut\s/g)) {
      // Drop `mut ` (keep one space between `let` and the name).
      const start = match.index + 3 + match[1].length;
      edits[i].push({ col: start, len: match[0].length - 3 - match[1].length, text: "" });
    }
    // `let mut xs = []` fixes to `never[]` under strict TS — widen it.
    for (const match of line.matchAll(/\blet\s+mut\s+[A-Za-z_$][\w$]*(\s*=\s*\[\])/g)) {
      const col = match.index + match[0].length - match[1].length;
      edits[i].push({ col, len: 0, text: ": any[]" });
    }
    for (const match of line.matchAll(/\blet(\s+[A-Za-z_$][\w$]*\s*)=>/g)) {
      edits[i].push({ col: match.index, len: 3, text: "const" });
      edits[i].push({ col: match.index + 3 + match[1].length, len: 2, text: "=" });
    }
  });

  const mapping = edits.map((lineEdits) => lineEdits.sort((a, b) => a.col - b.col));
  const tsxLines = lines.map((line, i) => applyEdits(line, mapping[i]));
  return { tsxText: tsxLines.join("\n"), mapping };
}

/**
 * `label: string = "Count", onRemove` ->
 * `{ label = "Count", onRemove }: { label?: string; onRemove: any; children?: any }`
 * Returns null when the params can't be converted (empty, rest args, ...).
 */
function componentProps(source) {
  if (!source.trim() || source.includes("...")) return null;
  const parts = splitTopLevel(source);
  const bindings = [];
  const types = [];
  for (const part of parts) {
    const match = part
      .trim()
      .match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/s);
    if (!match) return null;
    const [, name, type, fallback] = match;
    bindings.push(fallback ? `${name} = ${fallback}` : name);
    types.push(`${name}${fallback ? "?" : ""}: ${type?.trim() ?? "any"}`);
  }
  return `{ ${bindings.join(", ")} }: { ${types.join("; ")}; children?: any }`;
}

/** Split on commas that are not nested in brackets or strings. */
function splitTopLevel(source) {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (const ch of source) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function applyEdits(line, lineEdits) {
  let out = "";
  let cursor = 0;
  for (const edit of lineEdits) {
    out += line.slice(cursor, edit.col) + edit.text;
    cursor = edit.col + edit.len;
  }
  return out + line.slice(cursor);
}

/** Find the `}` matching the `{` at `open`. Naive: ignores strings/comments. */
function matchingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** `.ck` column -> TSX column for one line. */
function ckToTsxCol(lineEdits, col) {
  let delta = 0;
  for (const edit of lineEdits) {
    if (col <= edit.col) break;
    if (col < edit.col + edit.len) return edit.col + delta + edit.text.length;
    delta += edit.text.length - edit.len;
  }
  return col + delta;
}

/** TSX column -> `.ck` column for one line. */
function tsxToCkCol(lineEdits, col) {
  let delta = 0;
  for (const edit of lineEdits) {
    const dstStart = edit.col + delta;
    if (col <= dstStart) break;
    if (col < dstStart + edit.text.length) return edit.col;
    delta += edit.text.length - edit.len;
  }
  return col - delta;
}

/** `file://` URI (or already-a-path) -> filesystem path, null when neither. */
function toFilePath(uri) {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  return uri.startsWith("/") ? uri : null;
}

function cookedEnv() {
  return `
declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
declare function rt<T>(value: T): T;
declare function effect(fn: () => void): void;
declare function createStore<T>(initial: T): T;
declare function createActions<TStore, TActions>(store: TStore, factory: (store: TStore) => TActions): TActions;
declare function atom<T>(value: T): { value: T };
declare function signal<T>(value: T): { value: T };
declare function memo<T>(fn: () => T): { value: T };
declare function batch(fn: () => void): void;
declare const Keyed: any;
declare const children: any;
`;
}

function offsetAt(value, line, character) {
  let offset = 0;
  const lines = value.split(/\n/);
  for (let i = 0; i < Math.min(line, lines.length); i += 1) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset + character, value.length);
}

function positionAt(value, offset) {
  const prefix = value.slice(0, Math.max(0, Math.min(offset, value.length)));
  const lines = prefix.split(/\n/);
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  };
}

/** TSX text span -> `.ck` range. */
function span(file, textSpan) {
  const start = positionAt(file.tsxText, textSpan.start);
  const end = positionAt(file.tsxText, textSpan.start + Math.max(textSpan.length, 1));
  return {
    start: {
      line: start.line,
      character: tsxToCkCol(file.mapping[start.line] ?? [], start.character),
    },
    end: {
      line: end.line,
      character: tsxToCkCol(file.mapping[end.line] ?? [], end.character),
    },
  };
}
