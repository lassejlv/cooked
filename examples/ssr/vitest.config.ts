/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import cooked from "@cookedjs/vite-plugin-cooked";

export default defineConfig({
  plugins: [cooked()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
