import { defineConfig } from "vite";
import cooked from "vite-plugin-cooked";

export default defineConfig({
  plugins: [cooked()],
});
