import ts from "typescript";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const input = JSON.parse(readFileSync(0, "utf8"));
const text = cookedToTsx(input.text ?? "");
const fileName = input.fileName?.replace(/\.ck$/, ".ck.tsx") ?? "file:///virtual/App.ck.tsx";
const envFile = "cooked-env.d.ts";
const files = new Map([
  [fileName, { text, version: "0" }],
  [envFile, { text: cookedEnv(), version: "0" }],
]);

const options = {
  allowJs: false,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  types: [],
};

const host = {
  getCompilationSettings: () => options,
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
  getScriptFileNames: () => Array.from(files.keys()),
  getScriptVersion: (name) => files.get(name)?.version ?? "0",
  getScriptSnapshot(name) {
    const file = files.get(name);
    if (file) {
      return ts.ScriptSnapshot.fromString(file.text);
    }
    if (ts.sys.fileExists(name)) {
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? "");
    }
    return undefined;
  },
  fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
  readFile: (name) => files.get(name)?.text ?? ts.sys.readFile(name),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const offset = offsetAt(text, input.position?.line ?? 0, input.position?.character ?? 0);

try {
  switch (input.action) {
    case "completion":
      completion();
      break;
    case "hover":
      hover();
      break;
    case "definition":
      definition();
      break;
    case "diagnostics":
      diagnostics();
      break;
    default:
      print({ ok: false, error: `Unknown action ${input.action}` });
  }
} finally {
  service.dispose();
}

function completion() {
  const result = service.getCompletionsAtPosition(fileName, offset, {
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
    includeInsertTextCompletions: true,
    triggerCharacter: input.triggerCharacter,
  });
  print({
    ok: true,
    items: (result?.entries ?? []).slice(0, 80).map((entry) => ({
      label: entry.name,
      kind: entry.kind,
      detail: entry.source ? `TypeScript from ${entry.source}` : "TypeScript",
      insertText: entry.insertText,
    })),
  });
}

function hover() {
  const info = service.getQuickInfoAtPosition(fileName, offset);
  if (!info) {
    print({ ok: true });
    return;
  }
  const display = ts.displayPartsToString(info.displayParts ?? []);
  const docs = ts.displayPartsToString(info.documentation ?? []);
  print({
    ok: true,
    text: [display, docs].filter(Boolean).join("\n\n"),
    span: span(info.textSpan),
  });
}

function definition() {
  const defs = service.getDefinitionAtPosition(fileName, offset) ?? [];
  print({
    ok: true,
    definitions: defs
      .filter((def) => def.fileName === fileName)
      .map((def) => ({ span: span(def.textSpan) })),
  });
}

function diagnostics() {
  const all = [
    ...service.getSyntacticDiagnostics(fileName),
    ...service.getSemanticDiagnostics(fileName),
    ...service.getSuggestionDiagnostics(fileName),
  ];
  print({
    ok: true,
    diagnostics: all.map((diag) => ({
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      category: ts.DiagnosticCategory[diag.category],
      code: diag.code,
      span: span({ start: diag.start ?? 0, length: diag.length ?? 1 }),
    })),
  });
}

function cookedToTsx(source) {
  return source
    .replace(/\bexport\s+async\s+fn\b/g, "export async function")
    .replace(/\bexport\s+fn\b/g, "export function")
    .replace(/\basync\s+fn\b/g, "async function")
    .replace(/\bfn\b/g, "function")
    .replace(/\blet\s+mut\s+([A-Za-z_$][\w$]*)/g, "let $1")
    .replace(/\blet\s+([A-Za-z_$][\w$]*)\s*=>\s*([^;\n]+)/g, "const $1 = $2")
    .replace(/\beffect\s*\{/g, "effect(() => {");
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

function span(textSpan) {
  const start = positionAt(text, textSpan.start);
  const end = positionAt(text, textSpan.start + Math.max(textSpan.length, 1));
  return { start, end };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
