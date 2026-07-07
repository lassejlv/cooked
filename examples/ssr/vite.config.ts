import { defineConfig } from "vite";
import cooked from "@cookedjs/vite-plugin-cooked";

export default defineConfig({
  plugins: [cooked()],
});
