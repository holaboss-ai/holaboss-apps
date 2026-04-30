#!/usr/bin/env node
/**
 * Validates each app's `data_schema:` block in app.runtime.yaml.
 *
 * The runtime parser at holaOS/runtime/api-server/src/data-schema.ts
 * is the canonical authority — when it rejects a manifest at app
 * start, it logs a warning and falls back to the app's in-process
 * ensureSchema. The fallback works, so the app still runs, but you
 * get drift between the declared schema and the applied one with no
 * loud signal.
 *
 * This script catches that at PR time. It re-implements just enough
 * of the parser to flag the failure modes that have actually bitten
 * us:
 *   - missing or non-integer version
 *   - tables that don't start with the app's id prefix
 *   - underscore-prefixed table names (reserved for runtime)
 *   - columns with no type
 *   - mixing column-level and table-level primary_key
 *
 * Usage:
 *   pnpm validate:schemas        # all apps
 *   pnpm validate:schemas twitter linkedin   # just these
 *
 * Returns non-zero exit code if any app fails. Use in CI / pre-commit.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const NAME_RE = /^[a-z][a-z0-9_]*$/

function listApps(filter) {
  const dirs = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${REPO_ROOT}/${e.name}/app.runtime.yaml`))
    .map((e) => e.name)
  return filter.length > 0 ? dirs.filter((d) => filter.includes(d)) : dirs
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validate(app) {
  const yamlPath = `${REPO_ROOT}/${app}/app.runtime.yaml`
  const loaded = yaml.load(readFileSync(yamlPath, "utf8"))
  if (!isRecord(loaded)) throw new Error("app.runtime.yaml must be a mapping")

  const appId = String(loaded.slug ?? loaded.app_id ?? app)
  const dataSchema = loaded.data_schema
  if (dataSchema === undefined) return { app, status: "skipped", reason: "no data_schema" }
  if (!isRecord(dataSchema)) throw new Error("data_schema must be an object")

  const v = dataSchema.version
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`data_schema.version must be a positive integer (got ${JSON.stringify(v)})`)
  }
  if (!isRecord(dataSchema.tables)) throw new Error("data_schema.tables must be an object")

  const tableNames = Object.keys(dataSchema.tables)
  if (tableNames.length === 0) throw new Error("data_schema.tables must declare at least one table")

  for (const tableName of tableNames) {
    const path = `data_schema.tables.${tableName}`
    if (!NAME_RE.test(tableName)) throw new Error(`${path}: table name must be lower_snake_case`)
    if (tableName.startsWith("_")) {
      throw new Error(`${path}: must not start with "_" (reserved for runtime-internal tables)`)
    }
    if (!tableName.startsWith(`${appId}_`)) {
      throw new Error(`${path}: must start with app id prefix "${appId}_" — got "${tableName}"`)
    }
    const table = dataSchema.tables[tableName]
    if (!isRecord(table)) throw new Error(`${path}: must be an object`)

    if (table.visibility !== undefined &&
        !["user_facing", "app_internal", "runtime_internal"].includes(table.visibility)) {
      throw new Error(`${path}.visibility: must be user_facing | app_internal | runtime_internal`)
    }

    if (!isRecord(table.columns)) throw new Error(`${path}.columns: must be an object`)
    const columnNames = Object.keys(table.columns)
    if (columnNames.length === 0) throw new Error(`${path}.columns: must declare at least one column`)

    let columnLevelPk = false
    for (const colName of columnNames) {
      const cPath = `${path}.columns.${colName}`
      if (!NAME_RE.test(colName)) throw new Error(`${cPath}: must be lower_snake_case`)
      const col = table.columns[colName]
      if (!isRecord(col)) throw new Error(`${cPath}: must be an object with at least { type }`)
      if (typeof col.type !== "string" || col.type.trim() === "") {
        throw new Error(`${cPath}.type: must be a non-empty SQL type string`)
      }
      if (col.primary_key === true) columnLevelPk = true
    }

    if (table.primary_key !== undefined) {
      if (!Array.isArray(table.primary_key) || table.primary_key.some((c) => typeof c !== "string")) {
        throw new Error(`${path}.primary_key: must be an array of column names`)
      }
      if (table.primary_key.length === 0) {
        throw new Error(`${path}.primary_key: must contain at least one column name`)
      }
      const declared = new Set(columnNames)
      for (const c of table.primary_key) {
        if (!declared.has(c)) throw new Error(`${path}.primary_key: references undeclared column "${c}"`)
      }
      if (columnLevelPk) {
        throw new Error(`${path}: cannot combine table-level primary_key with column-level primary_key markers`)
      }
    }
  }

  return { app, status: "ok", version: v, tables: tableNames.length }
}

function main() {
  const filter = process.argv.slice(2)
  const apps = listApps(filter)
  let failures = 0
  let oks = 0
  let skipped = 0

  for (const app of apps) {
    try {
      const r = validate(app)
      if (r.status === "skipped") {
        process.stdout.write(`  skip   ${app.padEnd(12)}  ${r.reason}\n`)
        skipped += 1
      } else {
        process.stdout.write(`  ok     ${app.padEnd(12)}  v${r.version}, ${r.tables} tables\n`)
        oks += 1
      }
    } catch (e) {
      process.stderr.write(`  FAIL   ${app.padEnd(12)}  ${e.message}\n`)
      failures += 1
    }
  }

  process.stdout.write(`\n${oks} ok, ${skipped} skipped, ${failures} failed\n`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
