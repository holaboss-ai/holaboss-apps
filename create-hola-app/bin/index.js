#!/usr/bin/env node
import { cp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";

const SKIP_COPY = new Set([
  "node_modules",
  ".output",
  "dist",
  "data",
  ".turbo",
  ".git",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".md", ".html", ".css", ".svg",
  ".env", ".example",
]);

const REMOTE_PATTERN = /^(github|gh|gitlab|bitbucket|sourcehut|https?):/;
const DEFAULT_REMOTE = "github:holaboss-ai/hola-boss-apps/_template";

const CLI_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function toKebab(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const toSnake = (kebab) => kebab.replace(/-/g, "_");

function toTitle(kebab) {
  return kebab
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function parseArgs(argv) {
  const args = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--template") args.template = rest[++i];
    else if (a === "--display") args.display = rest[++i];
    else if (a === "--no-git") args.skipGit = true;
    else if (a === "--install") args.install = true;
    else if (a === "--no-install") args.install = false;
    else if (a === "-y" || a === "--yes") args.yes = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!a.startsWith("-") && !args.name) args.name = a;
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: create-hola-app [name] [options]

Options:
  --template <spec>   Local path or remote (github:owner/repo/subpath)
  --display <name>    Display name (default: Title Case of app name)
  --no-git            Skip git init
  --install           Install deps after scaffold
  --no-install        Skip dependency install prompt
  -y, --yes           Accept all defaults, no prompts
  -h, --help          Show this help

Examples:
  npx create-hola-app my-first-app
  npx create-hola-app my-first-app -y
  npx create-hola-app crm --template github:org/repo/path/to/template
`);
}

async function resolveTemplate(spec) {
  if (spec && REMOTE_PATTERN.test(spec)) return { kind: "remote", spec };
  if (spec) {
    const abs = path.resolve(spec);
    if (!(await exists(abs))) throw new Error(`Template not found: ${abs}`);
    return { kind: "local", path: abs };
  }
  const bundled = path.join(CLI_ROOT, "template");
  if (await exists(bundled)) return { kind: "local", path: bundled };
  const sibling = path.resolve(CLI_ROOT, "..", "_template");
  if (await exists(sibling)) return { kind: "local", path: sibling };
  return { kind: "remote", spec: DEFAULT_REMOTE };
}

async function copyLocal(source, target) {
  await cp(source, target, {
    recursive: true,
    filter: (src) => !SKIP_COPY.has(path.basename(src)),
  });
}

async function fetchRemote(spec, target) {
  const { downloadTemplate } = await import("giget");
  await downloadTemplate(spec, { dir: target, force: true, install: false });
}

function buildReplacements({ kebab, snake, title }) {
  return [
    ["Module Template", title],
    ["module-template", kebab],
    ['"module_', `"${snake}_`],
    ['slug: "template"', `slug: "${kebab}"`],
    ['destination: "your-module"', `destination: "${kebab}"`],
    ['"name": "module-template"', `"name": "${kebab}"`],
  ];
}

async function walk(dir, visit) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_COPY.has(entry.name)) continue;
      await walk(full, visit);
    } else if (entry.isFile()) {
      await visit(full);
    }
  }
}

async function applyReplacements(target, replacements) {
  await walk(target, async (file) => {
    const ext = path.extname(file);
    const base = path.basename(file);
    if (ext && !TEXT_EXT.has(ext) && base !== "Dockerfile" && base !== ".gitignore") return;
    let content;
    try { content = await readFile(file, "utf8"); } catch { return; }
    let next = content;
    for (const [from, to] of replacements) next = next.split(from).join(to);
    if (next !== content) await writeFile(file, next);
  });
}

async function safeRename(from, to) {
  if (!(await exists(from))) return;
  if (await exists(to)) return;
  await rename(from, to);
}

function bail(msg) {
  p.cancel(msg);
  process.exit(1);
}

function checkCancel(value, msg = "Cancelled") {
  if (p.isCancel(value)) bail(msg);
}

async function pickPackageManager(target) {
  if (await exists(path.join(target, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(target, "bun.lockb"))) return "bun";
  if (await exists(path.join(target, "yarn.lock"))) return "yarn";
  return "npm";
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  p.intro("create-hola-app");

  // Name
  let kebab;
  if (args.name) {
    kebab = toKebab(args.name);
    if (!kebab) bail(`Invalid app name: "${args.name}"`);
  } else if (args.yes) {
    kebab = "my-hola-app";
  } else {
    const value = await p.text({
      message: "What's your app named?",
      placeholder: "my-first-app",
      validate: (v) => {
        if (!v || !toKebab(v)) return "Please enter a valid name";
      },
    });
    checkCancel(value);
    kebab = toKebab(value);
  }

  const snake = toSnake(kebab);
  let title = args.display?.trim() || toTitle(kebab);
  if (!args.yes && !args.display) {
    const value = await p.text({
      message: "Display name?",
      defaultValue: title,
      placeholder: title,
    });
    checkCancel(value);
    if (value) title = value;
  }

  const target = path.resolve(process.cwd(), kebab);
  if (await exists(target)) bail(`Directory already exists: ${target}`);

  const tpl = await resolveTemplate(args.template);

  let shouldGit = args.skipGit !== true;
  if (!args.yes && args.skipGit === undefined) {
    const value = await p.confirm({ message: "Initialize git repo?", initialValue: true });
    checkCancel(value);
    shouldGit = value;
  }

  let shouldInstall = args.install ?? false;
  if (!args.yes && args.install === undefined) {
    const value = await p.confirm({ message: "Install dependencies now?", initialValue: false });
    checkCancel(value);
    shouldInstall = value;
  }

  const s = p.spinner();

  s.start(tpl.kind === "remote" ? `Fetching template (${tpl.spec})` : "Copying template");
  try {
    if (tpl.kind === "remote") {
      await fetchRemote(tpl.spec, target);
    } else {
      await copyLocal(tpl.path, target);
    }
    s.stop("Template ready");
  } catch (err) {
    s.stop("Template failed");
    bail(err.message || String(err));
  }

  s.start("Customizing files");
  await safeRename(path.join(target, "gitignore"), path.join(target, ".gitignore"));
  await safeRename(path.join(target, "_gitignore"), path.join(target, ".gitignore"));
  await applyReplacements(target, buildReplacements({ kebab, snake, title }));
  s.stop("Files customized");

  if (shouldGit) {
    s.start("Initializing git");
    try {
      execSync("git init -q", { cwd: target, stdio: "ignore" });
      s.stop("Git initialized");
    } catch {
      s.stop("Git not available — skipped");
    }
  }

  let pm = "pnpm";
  if (shouldInstall) {
    pm = await pickPackageManager(target);
    s.start(`Installing dependencies with ${pm}`);
    try {
      execSync(`${pm} install`, { cwd: target, stdio: "ignore" });
      s.stop(`Installed with ${pm}`);
    } catch {
      s.stop(`${pm} install failed — run it manually`);
    }
  }

  const rel = path.relative(process.cwd(), target) || kebab;
  const steps = [`cd ${rel}`];
  if (!shouldInstall) steps.push(`${pm} install`);
  steps.push(`${pm} dev`);
  p.note(steps.join("\n"), "Next steps");

  p.outro(`Created ${kebab} — happy hacking!`);
}

main().catch((err) => {
  p.log.error(err?.message || String(err));
  process.exit(1);
});
