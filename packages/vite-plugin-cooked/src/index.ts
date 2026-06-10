import { compile } from "@cooked/binding";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plugin } from "vite";

const CK_RE = /\.ck$/;

export interface CookedOptions {
  /** Extra file extensions to treat as Cooked sources. */
  include?: RegExp;
  /** Write sibling `.d.ck.ts` files for TypeScript/editor tooling. */
  declarations?: boolean;
}

/**
 * Vite plugin: compiles `.ck` files to JS via the native Cooked compiler.
 * Works under both Vite (rollup/esbuild) and rolldown-vite — it only uses the
 * standard `transform` hook.
 */
export default function cooked(options: CookedOptions = {}): Plugin {
  const filter = options.include ?? CK_RE;
  const emitDeclarations = options.declarations ?? true;

  return {
    name: "vite-plugin-cooked",
    enforce: "pre",

    async transform(code, id) {
      if (!filter.test(id)) return null;

      const result = compile(code, id);
      if (result.errors.length > 0) {
        this.error(`[cooked] ${id}\n  ${result.errors.join("\n  ")}`);
      }
      if (emitDeclarations && result.declarations) {
        await writeDeclaration(id, result.declarations);
      }

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },

  };
}

async function writeDeclaration(id: string, declarations: string): Promise<void> {
  const file = declarationPath(id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, declarations);
}

function declarationPath(id: string): string {
  const clean = id.split("?", 1)[0];
  return clean.replace(/\.ck$/, ".d.ck.ts");
}
