#!/usr/bin/env bash
# Engineer access to a hosted stack's database. See README.md in this directory.
#
#   db-support.sh query <staging|live|live-eu> <file.sql> [--write]
#   db-support.sh setup|teardown <staging|live|live-eu>
#
# `query` runs the file through the stack's audited db-support job and prints the result.
# `setup` runs setup.sql once per stack, as the application's own user, after Terraform has turned
# on `db_support_access_enabled`; `teardown` runs teardown.sql before Terraform turns it off.
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

# Pinned like the db-support job's image in ../terraform/db_support_access.tf; bump both together.
image="docker.io/library/postgres:16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e"

random_suffix() {
  od -An -N4 -tx1 /dev/urandom | tr -d ' \n'
}

# Starts the db-support job with the run id and mode as its arguments, and waits for it. This calls
# the Cloud Run Admin API directly: some gcloud releases send an override field the API rejects.
execute_job() {
  local run="$1" mode="$2" token operation name done_flag
  token="$(gcloud auth print-access-token)"
  operation="$(curl -sS -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"overrides\":{\"containerOverrides\":[{\"args\":[\"$run\",\"$mode\"]}]}}" \
    "https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$prefix-db-support:run")"
  name="$(json_field name <<<"$operation")"
  if [ -z "$name" ]; then
    echo "db-support: the job did not start: $operation" >&2
    return 1
  fi
  echo "db-support: run $run started" >&2
  for _ in $(seq 1 180); do
    sleep 5
    operation="$(curl -sS -H "Authorization: Bearer $token" "https://run.googleapis.com/v2/$name")"
    done_flag="$(json_field done <<<"$operation")"
    [ "$done_flag" = "True" ] || continue
    if [ -n "$(json_field error <<<"$operation")" ]; then
      echo "db-support: run $run failed: $(json_field error <<<"$operation")" >&2
      return 1
    fi
    return 0
  done
  echo "db-support: gave up waiting for run $run after 15 minutes" >&2
  return 1
}

# Prints one top-level field of the JSON object on stdin, or nothing when it is absent.
json_field() {
  python3 -c 'import json, sys
value = json.load(sys.stdin).get(sys.argv[1])
print("" if value is None else value)' "$1"
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

  gcloud storage cp --quiet "$file" "gs://$bucket/$run.query.sql" --project="$project"
  local status=0
  execute_job "$run" "$mode" || status=$?
  gcloud storage cat "gs://$bucket/$run.result.txt" --project="$project" ||
    echo "db-support: run $run wrote no result" >&2
  gcloud storage rm --quiet "gs://$bucket/$run.*" --project="$project" || true
  exit "$status"
}

# Runs one of this directory's SQL files as the application's own user, from a throwaway job on the
# backend's service account. Only setup and teardown use this path.
run_as_app() {
  local sql_file="$1" here job status=0
  here="$(cd "$(dirname "$0")" && pwd)"
  job="$prefix-db-support-app-$(random_suffix)"
  env_file="$(mktemp)"
  trap 'rm -f "$env_file"' EXIT

  {
    echo "SUPPORT_USER: \"$support_user\""
    echo "SQL: |"
    sed 's/^/  /' "$here/$sql_file"
  } >"$env_file"

  gcloud run jobs create "$job" --project="$project" --region="$region" \
    --image="$image" \
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
  setup) run_as_app setup.sql ;;
  teardown) run_as_app teardown.sql ;;
  *) usage ;;
esac
