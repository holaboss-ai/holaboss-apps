#!/usr/bin/env node
// Runs during `npm pack` / `npm publish`: copies ../_template into ./template
// so the published package ships with the template bundled.

import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.resolve(root, "..", "_template");
const dest = path.resolve(root, "template");

const SKIP = new Set(["node_modules", ".output", "dist", "data", ".turbo", ".git"]);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(source))) {
  console.error(`[sync-template] source not found: ${source}`);
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await cp(source, dest, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    return !SKIP.has(base);
  },
});

console.log(`[sync-template] copied ${source} -> ${dest}`);
