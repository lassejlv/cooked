import { compile } from "@cooked/binding";
import type { Plugin } from "vite";

const CK_RE = /\.ck$/;

export interface CookedOptions {
  /** Extra file extensions to treat as Cooked sources. */
  include?: RegExp;
}

/**
 * Vite plugin: compiles `.ck` files to JS via the native Cooked compiler.
 * Works under both Vite (rollup/esbuild) and rolldown-vite — it only uses the
 * standard `transform` hook.
 */
export default function cooked(options: CookedOptions = {}): Plugin {
  const filter = options.include ?? CK_RE;

  return {
    name: "vite-plugin-cooked",
    enforce: "pre",

    transform(code, id) {
      if (!filter.test(id)) return null;

      const result = compile(code);
      if (result.errors.length > 0) {
        this.error(`[cooked] ${id}\n  ${result.errors.join("\n  ")}`);
      }

      return {
        code: result.code,
        map: null,
      };
    },
  };
}
