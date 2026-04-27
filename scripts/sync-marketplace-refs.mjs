#!/usr/bin/env node
// Rewrite per-app `default_ref` in marketplace.json to match each module's
// own package.json version. Runs after `changeset version` so the same PR
// that bumps versions also updates the manifest.
//
// Rules:
//   - A module is considered "per-app released" if its package.json has a
//     `version` field AND its name is NOT in `.changeset/config.json`'s
//     `ignore` array. Those modules get `default_ref: "<name>@<version>"`.
//   - Modules that are still on the legacy `v*` lockstep flow (i.e. listed in
//     `ignore`) are left untouched — they fall back to the manifest-level
//     `default_ref`, which is bumped by `build-apps.yml` on each `v*` push.
//
// This script is idempotent and exits 0 when there's nothing to change.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const manifestPath = resolve(repoRoot, 'marketplace.json');
const configPath = resolve(repoRoot, '.changeset', 'config.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const ignored = new Set(config.ignore ?? []);

let mutated = false;
for (const app of manifest.apps) {
  const moduleDir = app.path ?? app.name;
  const pkgPath = resolve(repoRoot, moduleDir, 'package.json');

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    // No package.json — skip silently. Module may have been removed or never had one.
    continue;
  }

  if (!pkg.version || !pkg.name) continue;
  if (ignored.has(pkg.name)) continue;

  const expected = `${pkg.name}@${pkg.version}`;
  if (app.default_ref !== expected) {
    console.log(`marketplace.json: ${app.name}.default_ref ${app.default_ref ?? '(unset)'} → ${expected}`);
    app.default_ref = expected;
    mutated = true;
  }
}

if (mutated) {
  // Preserve the file's existing 2-space indent and trailing newline.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('marketplace.json updated');
} else {
  console.log('marketplace.json unchanged');
}
