#!/usr/bin/env node
/**
 * create-cooked — scaffold a Cooked project.
 *
 *   npm create cooked            (prompts)
 *   npm create cooked my-app -- --template ssr
 */

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const TEMPLATES = ["spa", "ssr"];
const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2).filter((a) => a !== "--");
let name = args.find((a) => !a.startsWith("-"));
let template = args.includes("--template") ? args[args.indexOf("--template") + 1] : null;

const rl = createInterface({ input: process.stdin, output: process.stdout });
if (!name) {
  name = (await rl.question("Project name: ")).trim() || "cooked-app";
}
if (!template) {
  const answer = (await rl.question(`Template (${TEMPLATES.join("/")}) [ssr]: `)).trim();
  template = answer || "ssr";
}
rl.close();

if (!TEMPLATES.includes(template)) {
  console.error(`Unknown template "${template}" — pick one of: ${TEMPLATES.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z0-9@][a-z0-9-_./]*$/i.test(name)) {
  console.error(`Invalid project name "${name}"`);
  process.exit(1);
}

const target = resolve(process.cwd(), name);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`Directory "${name}" already exists and is not empty`);
  process.exit(1);
}

cpSync(join(here, "templates", template), target, { recursive: true });

// npm strips .gitignore from published tarballs — templates ship _gitignore.
const gitignore = join(target, "_gitignore");
if (existsSync(gitignore)) renameSync(gitignore, join(target, ".gitignore"));

const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = name.split("/").pop();
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`
Scaffolded a Cooked ${template.toUpperCase()} app in ${name}/

  cd ${name}
  npm install
  npm run dev
${template === "ssr" ? "\nProduction: npm run build, then node server.js (or bun server.js).\n" : ""}
Docs: https://github.com/lassejlv/cooked/tree/main/docs`);
