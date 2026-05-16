#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/local-ci-checks.sh [--all] [base-ref]

Runs the same path-scoped checks as .github/workflows/ci.yml locally.

Examples:
  scripts/local-ci-checks.sh
  scripts/local-ci-checks.sh origin/main
  scripts/local-ci-checks.sh --all
USAGE
}

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

RUN_ALL=false
BASE_REF="${BASE_REF:-origin/main}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)
      RUN_ALL=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      BASE_REF="$1"
      shift
      ;;
  esac
done

if [ "$BASE_REF" = "main" ]; then
  BASE_REF="origin/main"
fi

backend=false
frontend=false
docs=false
typescript_sdk=false
mcp_server=false
crawler=false
ee=false

mark_all() {
  backend=true
  frontend=true
  docs=true
  typescript_sdk=true
  mcp_server=true
  crawler=true
  ee=true
}

if [ "$RUN_ALL" = true ]; then
  mark_all
else
  if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
    echo "Base ref '$BASE_REF' was not found locally. Try: git fetch origin main" >&2
    exit 1
  fi

  while IFS= read -r path; do
    [ -n "$path" ] || continue

    case "$path" in
      .github/workflows/ci.yml|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|scripts/*)
        mark_all
        ;;
      .github/workflows/*|infra/*|.dockerignore|*/.dockerignore|Dockerfile|*/Dockerfile|*.Dockerfile)
        ;;
      backend/*)
        backend=true
        frontend=true
        docs=true
        typescript_sdk=true
        mcp_server=true
        ;;
      frontend/*)
        frontend=true
        ;;
      docs-portal/*)
        docs=true
        ;;
      docs/settings-docs/*)
        frontend=true
        docs=true
        ;;
      docs/*|readme.md)
        docs=true
        ;;
      typescript-sdk/*)
        frontend=true
        typescript_sdk=true
        ;;
      packages/radioso-mcp-server/*)
        mcp_server=true
        ;;
      packages/crawler/*)
        backend=true
        crawler=true
        ;;
      packages/document-parser/*|packages/connector-api/*)
        backend=true
        ;;
      ee/*)
        ee=true
        ;;
      *)
        mark_all
        ;;
    esac
  done < <(git diff --name-only "$BASE_REF...HEAD")
fi

if [ "$backend$frontend$docs$typescript_sdk$mcp_server$crawler$ee" = "falsefalsefalsefalsefalsefalsefalse" ]; then
  echo "No CI-relevant changes detected against $BASE_REF."
  exit 0
fi

postgres_container=""
redis_container=""

cleanup() {
  if [ -n "$postgres_container" ]; then
    docker rm -f "$postgres_container" >/dev/null 2>&1 || true
  fi
  if [ -n "$redis_container" ]; then
    docker rm -f "$redis_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run() {
  echo
  echo "==> $*"
  "$@"
}

run_sh() {
  echo
  echo "==> $*"
  bash -lc "$*"
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for local Postgres/Redis-backed checks." >&2
    exit 1
  fi
}

start_postgres() {
  if [ -n "${INTEGRATION_DATABASE_URL:-}" ]; then
    echo "Using existing INTEGRATION_DATABASE_URL."
    return
  fi

  require_docker
  postgres_container="radioso-local-ci-postgres-$$"
  run docker run -d --name "$postgres_container" \
    -e POSTGRES_DB=radioso_test \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_USER=postgres \
    -p 127.0.0.1::5432 \
    pgvector/pgvector:pg16

  postgres_port="$(docker port "$postgres_container" 5432/tcp | sed 's/.*://')"
  for _ in $(seq 1 40); do
    if docker exec "$postgres_container" pg_isready -U postgres -d radioso_test >/dev/null 2>&1; then
      export INTEGRATION_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${postgres_port}/radioso_test"
      return
    fi
    sleep 1
  done

  echo "Postgres did not become ready in time." >&2
  exit 1
}

start_redis() {
  if [ -n "${RADIOSO_MCP_SMOKE_REDIS_URL:-}" ]; then
    echo "Using existing RADIOSO_MCP_SMOKE_REDIS_URL."
    return
  fi

  require_docker
  redis_container="radioso-local-ci-redis-$$"
  run docker run -d --name "$redis_container" -p 127.0.0.1::6379 redis:7-alpine

  redis_port="$(docker port "$redis_container" 6379/tcp | sed 's/.*://')"
  for _ in $(seq 1 40); do
    if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then
      export RADIOSO_MCP_SMOKE_REDIS_URL="redis://127.0.0.1:${redis_port}"
      return
    fi
    sleep 1
  done

  echo "Redis did not become ready in time." >&2
  exit 1
}

run corepack enable
run corepack prepare pnpm@10.33.0 --activate

echo
echo "Selected local CI buckets:"
echo "  backend=$backend"
echo "  frontend=$frontend"
echo "  docs=$docs"
echo "  typescript_sdk=$typescript_sdk"
echo "  mcp_server=$mcp_server"
echo "  crawler=$crawler"
echo "  ee=$ee"

if [ "$backend" = true ]; then
  run pnpm install --frozen-lockfile --filter radioso-backend... --filter @radioso/crawler...
  run_sh "cd backend && pnpm run lint:boundaries"
  run_sh "cd backend && pnpm run build"
  run_sh "cd backend && pnpm run test:unit"
  start_postgres
  run_sh "cd backend && pnpm run test:integration"
  run_sh "cd backend && pnpm run test:contract"
fi

if [ "$frontend" = true ]; then
  run pnpm install --frozen-lockfile --filter radioso-frontend...
  run_sh "cd frontend && pnpm run lint"
  run_sh "cd frontend && pnpm run build"
  run_sh "cd frontend && pnpm test"
  if [ "$(uname -s)" = "Linux" ]; then
    run_sh "cd frontend && pnpm exec playwright install --with-deps chromium"
  else
    run_sh "cd frontend && pnpm exec playwright install chromium"
  fi
  run_sh "cd frontend && pnpm run test:e2e"
fi

if [ "$docs" = true ]; then
  run pnpm install --frozen-lockfile --filter radioso-docs-portal...
  run_sh "cd docs-portal && pnpm run lint"
  run_sh "cd docs-portal && pnpm run build"
fi

if [ "$typescript_sdk" = true ]; then
  run pnpm install --frozen-lockfile --filter @radioso/typescript-sdk...
  run_sh "cd typescript-sdk && pnpm run build"
  run_sh "cd typescript-sdk && pnpm test"
fi

if [ "$mcp_server" = true ]; then
  start_redis
  run pnpm install --frozen-lockfile --filter radioso-backend... --filter @radioso/mcp-server...
  run_sh "cd packages/radioso-mcp-server && pnpm run build"
  run_sh "cd packages/radioso-mcp-server && pnpm test"
  run_sh "cd packages/radioso-mcp-server && pnpm run smoke:all"
fi

if [ "$crawler" = true ]; then
  run pnpm install --frozen-lockfile --filter @radioso/crawler...
  run_sh "cd packages/crawler && pnpm run build"
  run_sh "cd packages/crawler && pnpm test"
fi

if [ "$ee" = true ]; then
  run pnpm install --frozen-lockfile --filter './ee/packages/*...'
  run_sh "cd ee && pnpm run build"
  run_sh "cd ee && pnpm test"
fi

echo
echo "Local CI checks passed."
