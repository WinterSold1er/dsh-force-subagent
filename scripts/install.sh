#!/usr/bin/env bash
# Install or uninstall the dsh-force-subagent bundle in a DSH profile.
# Idempotent: files are rewritten only when a value actually changes.
set -euo pipefail

PLUGIN_NAME=dsh-force-subagent

DRY_RUN=false
MODE=install

usage() {
  cat <<'EOF'
usage: install.sh [--dry-run] [--uninstall] [--help]

Install or uninstall the dsh-force-subagent bundle in a DSH profile.

  --dry-run     print intended changes and write nothing
  --uninstall   remove the dependency, bundle entry and symlink
  --help        show this help

environment overrides:
  PLUGIN_DIR        plugin checkout (default: parent directory of this script)
  DSH_PROFILE_DIR   DSH profile (default: $HOME/.dsh/profiles/web)
  DSH_NODE          node binary (default: node)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --uninstall) MODE=uninstall ;;
    --help | -h) usage; exit 0 ;;
    *)
      printf 'error: unknown argument: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

TS=$(date +%Y%m%d-%H%M%S)
CHANGED=0
BACKUPS=()

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

PLUGIN_DIR=${PLUGIN_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
DSH_PROFILE_DIR=${DSH_PROFILE_DIR:-${HOME}/.dsh/profiles/web}
DSH_NODE=${DSH_NODE:-node}

# ---- preflight: plugin -----------------------------------------------------
case "$PLUGIN_DIR" in
  /*) ;;
  *) fail "PLUGIN_DIR must be an absolute path: $PLUGIN_DIR" ;;
esac
[ -d "$PLUGIN_DIR" ] || fail "PLUGIN_DIR does not exist: $PLUGIN_DIR"
[ -f "$PLUGIN_DIR/package.json" ] || fail "missing package.json in PLUGIN_DIR: $PLUGIN_DIR/package.json"
[ -f "$PLUGIN_DIR/index.js" ] || fail "missing index.js in PLUGIN_DIR: $PLUGIN_DIR/index.js"
if ! pkg_name=$("$DSH_NODE" -e '
  const fs = require("node:fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof p.name !== "string") process.exit(1);
  process.stdout.write(p.name);
' "$PLUGIN_DIR/package.json"); then
  fail "cannot read a valid package.json with '$DSH_NODE': $PLUGIN_DIR/package.json"
fi
[ "$pkg_name" = "$PLUGIN_NAME" ] || fail "not the $PLUGIN_NAME plugin: package.json name is '$pkg_name' in $PLUGIN_DIR"

# ---- preflight: profile ----------------------------------------------------
case "$DSH_PROFILE_DIR" in
  /*) ;;
  *) fail "DSH_PROFILE_DIR must be an absolute path: $DSH_PROFILE_DIR" ;;
esac
[ -d "$DSH_PROFILE_DIR" ] || fail "DSH_PROFILE_DIR does not exist: $DSH_PROFILE_DIR"
[ -f "$DSH_PROFILE_DIR/package.json" ] || fail "missing package.json in DSH_PROFILE_DIR: $DSH_PROFILE_DIR/package.json"
if ! "$DSH_NODE" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));' \
  "$DSH_PROFILE_DIR/package.json" >/dev/null; then
  fail "profile package.json is not valid JSON: $DSH_PROFILE_DIR/package.json"
fi

PLUGIN_REAL=$(readlink -f -- "$PLUGIN_DIR") || fail "cannot resolve PLUGIN_DIR: $PLUGIN_DIR"
PROFILE_REAL=$(readlink -f -- "$DSH_PROFILE_DIR") || fail "cannot resolve DSH_PROFILE_DIR: $DSH_PROFILE_DIR"
PROFILE_PKG="$PROFILE_REAL/package.json"
LINK_DIR="$PROFILE_REAL/node_modules"
LINK_PATH="$LINK_DIR/$PLUGIN_NAME"

# ---- JSON editor -----------------------------------------------------------
# Exits 0 when nothing needs to change, 10 when a change was (or would be) made.
JSON_EDIT=$(cat <<'EOF'
"use strict";
const fs = require("node:fs");

const NAME = "dsh-force-subagent";
// With `node -e`, extra arguments start at process.argv[1].
const [file, mode, pluginReal, ts, dryRaw] = process.argv.slice(1);
const dry = dryRaw === "true";

function die(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

let obj;
try {
  obj = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  die(`cannot parse ${file}: ${err.message}`);
}
if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
  die(`${file}: top level must be a JSON object`);
}

const changes = [];
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

if (mode === "install") {
  if (obj.dependencies === undefined) obj.dependencies = {};
  if (!isPlainObject(obj.dependencies)) die(`${file}: dependencies must be an object`);

  const want = `file:${pluginReal}`;
  if (obj.dependencies[NAME] !== want) {
    obj.dependencies[NAME] = want;
    changes.push(`set dependencies["${NAME}"] = ${want}`);
  }

  if (obj.dsh === undefined) obj.dsh = {};
  if (!isPlainObject(obj.dsh)) die(`${file}: dsh must be an object`);
  if (obj.dsh.profile === undefined) obj.dsh.profile = {};
  if (!isPlainObject(obj.dsh.profile)) die(`${file}: dsh.profile must be an object`);
  if (obj.dsh.profile.bundles === undefined) obj.dsh.profile.bundles = [];
  if (!Array.isArray(obj.dsh.profile.bundles)) die(`${file}: dsh.profile.bundles must be an array`);

  const bundles = obj.dsh.profile.bundles;
  const hits = [];
  for (let i = 0; i < bundles.length; i += 1) {
    if (bundles[i] === NAME) hits.push(i);
  }
  if (hits.length === 0) {
    bundles.push(NAME);
    changes.push(`append dsh.profile.bundles[] entry "${NAME}"`);
  } else if (hits.length > 1) {
    const first = hits[0];
    obj.dsh.profile.bundles = bundles.filter((value, index) => index === first || value !== NAME);
    changes.push(`remove ${hits.length - 1} duplicate dsh.profile.bundles entry(ies) of "${NAME}"`);
  }
} else if (mode === "uninstall") {
  if (obj.dependencies !== undefined) {
    if (!isPlainObject(obj.dependencies)) die(`${file}: dependencies must be an object`);
    if (Object.prototype.hasOwnProperty.call(obj.dependencies, NAME)) {
      delete obj.dependencies[NAME];
      changes.push(`remove dependencies["${NAME}"]`);
    }
  }

  if (obj.dsh !== undefined) {
    if (!isPlainObject(obj.dsh)) die(`${file}: dsh must be an object`);
    const profile = obj.dsh.profile;
    if (profile !== undefined) {
      if (!isPlainObject(profile)) die(`${file}: dsh.profile must be an object`);
      const bundles = profile.bundles;
      if (bundles !== undefined) {
        if (!Array.isArray(bundles)) die(`${file}: dsh.profile.bundles must be an array`);
        const kept = bundles.filter((value) => value !== NAME);
        if (kept.length !== bundles.length) {
          changes.push(`remove ${bundles.length - kept.length} dsh.profile.bundles entry(ies) of "${NAME}"`);
          profile.bundles = kept;
        }
      }
    }
  }
} else {
  die(`unknown edit mode: ${mode}`);
}

if (changes.length === 0) process.exit(0);

const backup = `${file}.bak-${ts}`;
if (dry) {
  console.log(`would backup ${file} -> ${backup}`);
} else {
  fs.copyFileSync(file, backup);
  console.log(`backup ${file} -> ${backup}`);
}
for (const change of changes) console.log(dry ? `would ${change}` : change);
if (dry) process.exit(10);

const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
fs.chmodSync(tmp, fs.statSync(file).mode);
fs.renameSync(tmp, file);
process.exit(10);
EOF
)

edit_profile_json() {
  local rc=0
  "$DSH_NODE" -e "$JSON_EDIT" "$PROFILE_PKG" "$MODE" "$PLUGIN_REAL" "$TS" "$DRY_RUN" || rc=$?
  case "$rc" in
    0) ;;
    10)
      CHANGED=$((CHANGED + 1))
      if [ "$DRY_RUN" = true ] || [ -f "$PROFILE_PKG.bak-$TS" ]; then
        BACKUPS+=("$PROFILE_PKG.bak-$TS")
      fi
      ;;
    *) fail "failed to edit $PROFILE_PKG (see error above)" ;;
  esac
}

# ---- symlink ---------------------------------------------------------------
install_symlink() {
  local resolved=''

  if [ -e "$LINK_DIR" ] && [ ! -d "$LINK_DIR" ]; then
    fail "$LINK_DIR exists and is not a directory"
  fi
  if [ -L "$LINK_PATH" ]; then
    if ! resolved=$(readlink -f -- "$LINK_PATH"); then
      fail "$LINK_PATH is a dangling symlink; refusing to touch it"
    fi
    if [ "$resolved" = "$PLUGIN_REAL" ]; then
      printf 'already linked: %s -> %s\n' "$LINK_PATH" "$PLUGIN_REAL"
      return 0
    fi
    fail "$LINK_PATH points to $resolved, expected $PLUGIN_REAL; refusing to replace it"
  fi
  if [ -e "$LINK_PATH" ]; then
    fail "$LINK_PATH exists and is not a symlink; refusing to replace it (remove it manually)"
  fi

  if [ ! -d "$LINK_DIR" ]; then
    if [ "$DRY_RUN" = true ]; then
      printf 'would create directory %s\n' "$LINK_DIR"
    else
      mkdir -p -- "$LINK_DIR"
      printf 'created directory %s\n' "$LINK_DIR"
    fi
  fi

  if [ "$DRY_RUN" = true ]; then
    printf 'would create symlink %s -> %s\n' "$LINK_PATH" "$PLUGIN_REAL"
  else
    ln -s -- "$PLUGIN_REAL" "$LINK_PATH"
    printf 'created symlink %s -> %s\n' "$LINK_PATH" "$PLUGIN_REAL"
  fi
  CHANGED=$((CHANGED + 1))
}

uninstall_symlink() {
  local resolved=''

  if [ -L "$LINK_PATH" ]; then
    if ! resolved=$(readlink -f -- "$LINK_PATH"); then
      printf 'warning: %s is a dangling symlink; leaving it in place\n' "$LINK_PATH" >&2
      return 0
    fi
    if [ "$resolved" = "$PLUGIN_REAL" ]; then
      if [ "$DRY_RUN" = true ]; then
        printf 'would remove symlink %s\n' "$LINK_PATH"
      else
        rm -f -- "$LINK_PATH"
        printf 'removed symlink %s\n' "$LINK_PATH"
      fi
      CHANGED=$((CHANGED + 1))
    else
      printf 'warning: %s points to %s, not %s; leaving it in place\n' \
        "$LINK_PATH" "$resolved" "$PLUGIN_REAL" >&2
    fi
  elif [ -e "$LINK_PATH" ]; then
    printf 'warning: %s is not a symlink; leaving it in place\n' "$LINK_PATH" >&2
  fi
}

# ---- run -------------------------------------------------------------------
if [ "$MODE" = install ]; then
  install_symlink
  edit_profile_json
else
  edit_profile_json
  uninstall_symlink
fi

if [ "$CHANGED" -eq 0 ]; then
  if [ "$DRY_RUN" = true ]; then
    printf 'would: no changes (already %s)\n' "${MODE}ed"
  else
    printf 'already %s\n' "${MODE}ed"
  fi
fi

if [ "${#BACKUPS[@]}" -eq 0 ]; then
  backup_list=none
else
  backup_list=$(IFS=,; printf '%s' "${BACKUPS[*]}")
fi
printf 'mode=%s dry_run=%s changed=%s backups=%s\n' \
  "$MODE" "$DRY_RUN" "$CHANGED" "$backup_list"
