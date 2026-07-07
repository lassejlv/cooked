import { createSsrServer } from "@cookedjs/cooked/server";

// preset: "bun" -> native Bun.serve(), "node" -> node:http.
// Default "auto" picks Bun.serve when running under bun (`bun server.js`).
createSsrServer({ root: import.meta.dirname, preset: "bun" });
