/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import cooked from "vite-plugin-cooked";

export default defineConfig({
  plugins: [cooked()],
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
