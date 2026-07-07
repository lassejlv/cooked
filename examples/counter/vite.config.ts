import { defineConfig } from "vite";
import cooked from "@cookedjs/vite-plugin-cooked";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [cooked(), tailwindcss()],
});
