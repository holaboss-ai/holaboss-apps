#!/usr/bin/env bash
set -euo pipefail

# Build a pre-built archive for a Holaboss module app.
#
# Usage: ./scripts/build-archive.sh <module-dir> [--target <platform-arch>] [--output <path>]
#
# Options:
#   --target   Target platform (default: current host). Examples:
#              linux-x64       — Linux sandbox (Docker/Fly)
#              linux-x64-musl  — Alpine Linux sandbox
#              darwin-arm64    — macOS Apple Silicon (desktop provider)
#              host            — Current machine (default)
#   --output   Output archive path (default: dist/<slug>-module.tar.gz)
#
# Produces a self-contained .tar.gz — extract and run, no install needed.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Parse args
MODULE_DIR=""
OUTPUT_PATH=""
TARGET="host"

while [[ $# -gt 0 ]]; do
  case $1 in
    --output) OUTPUT_PATH="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    *) MODULE_DIR="$1"; shift ;;
  esac
done

if [[ -z "$MODULE_DIR" ]]; then
  echo "Usage: $0 <module-dir> [--target <platform-arch>] [--output <path>]"
  echo ""
  echo "Examples:"
  echo "  $0 twitter                           # build for current host"
  echo "  $0 twitter --target linux-x64         # build for Linux sandbox"
  echo "  $0 twitter --target linux-x64-musl    # build for Alpine sandbox"
  echo "  $0 twitter --target win32-x64         # build for Windows"
  exit 1
fi

# Resolve target platform/arch for native binary download
resolve_target() {
  local target="$1"
  if [[ "$target" == "host" ]]; then
    echo ""  # no cross-compile needed
    return
  fi

  local platform arch variant
  platform=$(echo "$target" | cut -d'-' -f1)
  arch=$(echo "$target" | cut -d'-' -f2)
  variant=$(echo "$target" | cut -d'-' -f3)  # e.g. "musl" for Alpine

  if [[ -n "$variant" ]]; then
    echo "${platform}${variant}-${arch}"  # e.g. linuxmusl-x64
  else
    echo "${platform}-${arch}"  # e.g. linux-x64
  fi
}

# Download prebuilt better-sqlite3 binary for a target platform
download_prebuilt_sqlite() {
  local target_slug="$1"  # e.g. linux-x64 or linuxmusl-x64
  local sqlite_dir="$2"   # path to better-sqlite3 in .output

  local abs_sqlite_dir
  abs_sqlite_dir=$(cd "$sqlite_dir" && pwd)
  local version
  version=$(node -e "console.log(require('${abs_sqlite_dir}/package.json').version)")
  local node_abi
  node_abi=$(node -e "console.log(process.versions.modules)")

  local filename="better-sqlite3-v${version}-node-v${node_abi}-${target_slug}.tar.gz"
  local url="https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${filename}"

  echo "  Downloading ${filename}..."
  local tmpdir
  tmpdir=$(mktemp -d)
  if ! curl -sL "$url" -o "${tmpdir}/prebuild.tar.gz"; then
    echo "Error: failed to download $url" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  # Extract and replace the native binary
  tar xzf "${tmpdir}/prebuild.tar.gz" -C "$tmpdir"
  cp -f "${tmpdir}/build/Release/better_sqlite3.node" \
        "${sqlite_dir}/build/Release/better_sqlite3.node"

  local binary_platform
  binary_platform=$(file "${sqlite_dir}/build/Release/better_sqlite3.node" | grep -o 'ELF\|Mach-O\|PE32' | head -1)
  echo "  Replaced native binary (${binary_platform:-unknown})"
  rm -rf "$tmpdir"
}

build_module() {
  local module="$1"
  local module_path="$REPO_DIR/$module"

  if [[ ! -d "$module_path" ]]; then
    echo "Error: module directory not found: $module_path" >&2
    exit 1
  fi

  if [[ ! -f "$module_path/app.runtime.yaml" ]]; then
    echo "Error: no app.runtime.yaml in $module_path" >&2
    exit 1
  fi

  local slug
  slug=$(grep '^slug:' "$module_path/app.runtime.yaml" | awk '{print $2}' | tr -d '"')
  if [[ -z "$slug" ]]; then
    slug="$module"
  fi

  local target_suffix=""
  if [[ "$TARGET" != "host" ]]; then
    target_suffix="-${TARGET}"
  fi
  local archive="${OUTPUT_PATH:-$REPO_DIR/dist/${slug}-module${target_suffix}.tar.gz}"
  mkdir -p "$(dirname "$archive")"

  local target_slug
  target_slug=$(resolve_target "$TARGET")

  echo "=== Building $module${target_slug:+ (target: $TARGET)} ==="

  cd "$module_path"

  # Step 1: Install (all deps, needed for build)
  echo "[1/4] Installing dependencies..."
  corepack enable 2>/dev/null
  if [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile 2>&1 | tail -1
  else
    pnpm install 2>&1 | tail -1
  fi

  # Step 2: Build (vite + esbuild services bundle)
  echo "[2/4] Building..."
  pnpm run build 2>&1 | tail -1

  # Step 3: Prepare runtime dependencies
  echo "[3/4] Preparing runtime dependencies..."

  # Cross-compile: replace native binary if targeting different platform
  if [[ -n "$target_slug" ]]; then
    local sqlite_dir=".output/server/node_modules/better-sqlite3"
    if [[ -d "$sqlite_dir" ]]; then
      download_prebuilt_sqlite "$target_slug" "$sqlite_dir"
    fi
  fi

  # Copy (not symlink) server/node_modules to .output/node_modules
  # so start-services.cjs can resolve better-sqlite3.
  # Using cp instead of symlink for Windows compatibility.
  # Done AFTER cross-compile so the correct binary is copied.
  rm -rf .output/node_modules
  cp -r .output/server/node_modules .output/node_modules

  # Step 4: Create archive
  echo "[4/4] Packaging → $archive"
  tar czf "$archive" \
    .output/ \
    app.runtime.yaml \
    package.json

  local size
  size=$(du -h "$archive" | cut -f1)
  echo "=== Done: $slug ($size) ==="
  echo ""
}

build_module "$MODULE_DIR"
