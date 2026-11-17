#!/usr/bin/env bash
# Engineer access to a hosted stack's database. See README.md in this directory.
#
#   db-support.sh query <staging|live|live-eu> <file.sql> [--write]
#   db-support.sh setup <staging|live|live-eu>
#
# `query` runs the file through the stack's audited db-support job and prints the result.
# `setup` runs setup.sql once per stack, as the application's own user, after Terraform has turned
# on `db_support_access_enabled`.
set -euo pipefail

usage() {
  sed -n '4,5p' "$0" | sed 's/^# *//'
  exit 2
}

[ $# -ge 2 ] || usage
command="$1"
stack="$2"

case "$stack" in
  staging)
    project="radioso-staging" region="us-central1" log_bucket=""
    ;;
  live)
    project="radioso-494120" region="us-central1" log_bucket=""
    ;;
  live-eu)
    project="radioso-494120" region="europe-west1" log_bucket="radioso-live-eu-logs"
    ;;
  *) usage ;;
esac
prefix="radioso-$stack"
support_user="$prefix-db-support@$project.iam"

random_suffix() {
  od -An -N4 -tx1 /dev/urandom | tr -d ' \n'
}

query() {
  local file="$1" mode="read"
  [ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
  if [ "${2:-}" = "--write" ]; then
    mode="write"
  elif [ -n "${2:-}" ]; then
    usage
  fi

  local bucket="$project-$prefix-db-support-results"
  local run
  run="$(date -u +%Y%m%d-%H%M%S)-$(random_suffix)"

  gcloud storage cp --quiet "$file" "gs://$bucket/$run/query.sql" --project="$project"
  local status=0
  gcloud run jobs execute "$prefix-db-support" --project="$project" --region="$region" \
    --args="$run,$mode" --wait --quiet || status=$?
  gcloud storage cat "gs://$bucket/$run/result.txt" --project="$project" ||
    echo "db-support: run $run wrote no result" >&2
  gcloud storage rm --recursive --quiet "gs://$bucket/$run" --project="$project" || true
  exit "$status"
}

setup() {
  local here job env_file status=0
  here="$(cd "$(dirname "$0")" && pwd)"
  job="$prefix-db-support-setup-$(random_suffix)"
  env_file="$(mktemp)"
  trap 'rm -f "$env_file"' RETURN

  {
    echo "SUPPORT_USER: \"$support_user\""
    echo "SQL: |"
    sed 's/^/  /' "$here/setup.sql"
  } >"$env_file"

  gcloud run jobs create "$job" --project="$project" --region="$region" \
    --image=docker.io/library/postgres:16-alpine \
    --service-account="$prefix-backend@$project.iam.gserviceaccount.com" \
    --network="$prefix-vpc" --subnet="$prefix-subnet" --vpc-egress=private-ranges-only \
    --set-secrets="DATABASE_URL=$prefix-database-url:latest" \
    --env-vars-file="$env_file" --max-retries=0 --task-timeout=600s --quiet \
    --command=sh \
    --args=-c,'printf "%s\n" "$SQL" | psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v support_user="$SUPPORT_USER" -e'
  gcloud run jobs execute "$job" --project="$project" --region="$region" --wait --quiet || status=$?

  local bucket_flags=()
  if [ -n "$log_bucket" ]; then
    bucket_flags=(--bucket="$log_bucket" --location="$region" --view=_AllLogs)
  fi
  # Cloud Logging takes a few seconds to receive the last lines.
  sleep 15
  gcloud logging read \
    "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$job\" AND resource.labels.location=\"$region\"" \
    --project="$project" ${bucket_flags[@]+"${bucket_flags[@]}"} --order=asc --freshness=1h \
    --format='value(textPayload)' || true

  gcloud run jobs delete "$job" --project="$project" --region="$region" --quiet
  return "$status"
}

case "$command" in
  query)
    [ $# -ge 3 ] || usage
    query "$3" "${4:-}"
    ;;
  setup) setup ;;
  *) usage ;;
esac
