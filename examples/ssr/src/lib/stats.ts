// Server functions work in ANY module — this file also has a client export.
import { createServerFn } from "@cookedjs/cooked/fn";

export const APP_NAME = "Cooked SSR example";

export const serverStats = createServerFn().handler(() => ({
  node: process.version,
  uptimeSeconds: Math.round(process.uptime()),
}));
