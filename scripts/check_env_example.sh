#!/usr/bin/env bash
set -uo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# check_env_example.sh — Validate that .env.example files contain every env var
# referenced in the application source code.
#
# Usage:
#   scripts/check_env_example.sh          # check all services
#   scripts/check_env_example.sh backend   # check a single service
#
# Exit codes:
#   0 — all referenced env vars are present in the corresponding .env.example
#   1 — one or more referenced env vars are missing from .env.example
#
# False-positive suppression:
#   Add a comment in the source file on the same line as the env reference:
#     // env-check:ignore VAR_NAME        (TypeScript / JavaScript)
#     #  env-check:ignore VAR_NAME        (shell)
#   Or add a global suppression at the top of the .env.example file:
#     # env-check:ignore VAR_NAME
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Built-in env vars that never need to appear in .env.example
BUILTINS=(
  NODE_ENV
  DEV
  PROD
  MODE
  BASE_URL
  SSR
  IMPORT_META_ENV
)

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Track overall status
exit_code=0

# ─── Helpers ─────────────────────────────────────────────────────────────────

# Check whether a var name is in the built-in exclusion list.
is_builtin() {
  local var="$1"
  for b in "${BUILTINS[@]}"; do
    [[ "$var" == "$b" ]] && return 0
  done
  return 1
}

# Extract env var names from .env.example (left side of KEY=).
get_example_keys() {
  local example_file="$1"
  [[ -f "$example_file" ]] || return 0
  grep -oE '^[A-Z][A-Z0-9_]*=' "$example_file" | sed 's/=$//' | sort -u
}

# Extract global suppressions from .env.example (# env-check:ignore VAR).
get_example_suppressions() {
  local example_file="$1"
  [[ -f "$example_file" ]] || return 0
  grep -oE '^#.*env-check:ignore[[:space:]]+[A-Z][A-Z0-9_]+' "$example_file" \
    | grep -oE '[A-Z][A-Z0-9_]+$' | sort -u
}

# Extract env var references from source files.
# Scans .ts/.tsx/.js/.jsx for process.env.* and import.meta.env.*
# Scans .sh for $VAR and ${VAR}
# Excludes test files and node_modules.
get_source_vars() {
  local src_dir="$1"
  local pattern="$2"

  [[ -d "$src_dir" ]] || return 0

  if [[ "$pattern" == "node" ]]; then
    # TypeScript / JavaScript: process.env.* and import.meta.env.*
    grep -rohE 'process\.env\.[A-Z][A-Z0-9_]*|import\.meta\.env\.[A-Z][A-Z0-9_]*' \
      "$src_dir" \
      --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ \
      --exclude='*.test.*' --exclude='*.spec.*' \
    | sed -E 's/process\.env\.//; s/import\.meta\.env\.//' \
    | sort -u
  elif [[ "$pattern" == "shell" ]]; then
    # Shell scripts: ${VAR} and $VAR patterns
    grep -rohE '\$\{?([A-Z][A-Z0-9_]*)\}?' "$src_dir" \
      --include='*.sh' \
      --exclude-dir=node_modules \
    | sed -E 's/\$\{?//; s/\}?//' \
    | sort -u
  fi
}

# Get line-level suppressions from source files.
# Returns lines in format: VAR_NAME for each suppressed var found in the source.
get_source_suppressions() {
  local src_dir="$1"
  [[ -d "$src_dir" ]] || return 0
  grep -rohE '(//|#)\s*env-check:ignore\s+[A-Z][A-Z0-9_]+' \
    "$src_dir" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.sh' \
    --exclude-dir=node_modules \
  | grep -oE '[A-Z][A-Z0-9_]+$' | sort -u
}

# Check a single service directory.
check_service() {
  local name="$1"
  local src_dir="$2"
  local example_file="$3"
  local pattern="${4:-node}"

  echo ""
  echo "── ${name} ────────────────────────────────────────────────────────────"

  if [[ ! -f "$example_file" ]]; then
    echo -e "${RED}  ✗ .env.example not found: ${example_file}${NC}"
    exit_code=1
    return
  fi

  if [[ ! -d "$src_dir" ]]; then
    echo -e "${YELLOW}  ⚠ source directory not found: ${src_dir} — skipping${NC}"
    return
  fi

  # Collect referenced env vars from source code
  mapfile -t source_vars < <(get_source_vars "$src_dir" "$pattern")
  # Collect defined keys from .env.example
  mapfile -t example_keys < <(get_example_keys "$example_file")
  # Collect suppressions from source and .env.example
  mapfile -t source_supp < <(get_source_suppressions "$src_dir")
  mapfile -t example_supp < <(get_example_suppressions "$example_file")

  # Build an associative array of example keys for fast lookup
  declare -A example_map
  for k in "${example_keys[@]}"; do
    example_map["$k"]=1
  done

  # Build suppression set
  declare -A supp_map
  for s in "${source_supp[@]}" "${example_supp[@]}"; do
    [[ -n "$s" ]] && supp_map["$s"]=1
  done

  local missing=()
  local found=0
  local suppressed=0

  for var in "${source_vars[@]}"; do
    [[ -z "$var" ]] && continue
    if is_builtin "$var"; then
      continue
    fi
    if [[ -n "${supp_map[$var]:-}" ]]; then
      ((suppressed++)) || true
      continue
    fi
    if [[ -z "${example_map[$var]:-}" ]]; then
      missing+=("$var")
    else
      ((found++)) || true
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo -e "${GREEN}  ✓ All ${found} referenced env var(s) are present in ${example_file}${NC}"
    [[ $suppressed -gt 0 ]] && echo -e "${YELLOW}  ℹ ${suppressed} false positive(s) suppressed${NC}"
  else
    echo -e "${RED}  ✗ ${#missing[@]} env var(s) referenced in code but missing from ${example_file}:${NC}"
    for m in "${missing[@]}"; do
      echo -e "${RED}    - ${m}${NC}"
    done
    echo ""
    echo -e "  To suppress a false positive, add this comment in the source file:"
    echo -e "    // env-check:ignore ${m}"
    echo -e "  Or add this to ${example_file}:"
    echo -e "    # env-check:ignore ${m}"
    exit_code=1
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

# Service definitions: name | source dir | .env.example path | pattern
services=(
  "backend|${ROOT_DIR}/backend/src|${ROOT_DIR}/backend/.env.example|node"
  "frontend|${ROOT_DIR}/frontend/src|${ROOT_DIR}/frontend/.env.example|node"
  "notification-service|${ROOT_DIR}/notification-service/src|${ROOT_DIR}/notification-service/.env.example|node"
)

# If an argument is provided, check only that service
if [[ $# -gt 0 ]]; then
  filter="$1"
  filtered=()
  for svc in "${services[@]}"; do
    name="${svc%%|*}"
    if [[ "$name" == "$filter" ]]; then
      filtered+=("$svc")
    fi
  done
  if [[ ${#filtered[@]} -eq 0 ]]; then
    echo "Unknown service: $filter"
    echo "Available: backend frontend notification-service root-scripts"
    exit 1
  fi
  services=("${filtered[@]}")
fi

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║        .env.example Completeness Validation                         ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"

for svc in "${services[@]}"; do
  IFS='|' read -r name src_dir example_file pattern <<< "$svc"
  check_service "$name" "$src_dir" "$example_file" "$pattern"
done

echo ""
if [[ $exit_code -eq 0 ]]; then
  echo -e "${GREEN}✓ All .env.example files are complete.${NC}"
else
  echo -e "${RED}✗ Some .env.example files are missing referenced env vars.${NC}"
  echo -e "${RED}  See above for details.${NC}"
fi

exit $exit_code
