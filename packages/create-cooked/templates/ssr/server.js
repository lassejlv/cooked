import { createSsrServer } from "@cookedjs/cooked/server";

// preset "auto" picks native Bun.serve() under bun, node:http on node.
createSsrServer({ root: import.meta.dirname, preset: "auto" });
