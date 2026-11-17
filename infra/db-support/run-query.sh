# Runs inside the db-support Cloud Run job (../terraform/db_support_access.tf) as `sh -c`, with the
# run id and mode as $1 and $2. The query is read from, and the result written to, the results
# bucket mounted at /results, so neither reaches the job's log. Only the exit status is printed.

run="$1"
mode="$2"

case "$run" in
  "" | *[!a-z0-9-]*)
    echo "db-support: the run id must be lowercase letters, digits and dashes"
    exit 2
    ;;
esac

query="/results/$run.query.sql"
result="/results/$run.result.txt"
if [ ! -f "$query" ]; then
  echo "db-support: run $run has no query"
  exit 2
fi

# The job's service account signs in with a short-lived access token as its password.
token="$(wget -q -O - --header "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" |
  sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')"
if [ -z "$token" ]; then
  echo "db-support: no access token from the metadata server"
  exit 3
fi

# Read-only unless the engineer asked for a write: a guard against mistakes rather than a
# permission, since the session may lift it. The audit records either way.
options="-c default_transaction_read_only=on"
if [ "$mode" = "write" ]; then
  options=""
fi

# One transaction, so a failing write leaves nothing half done. The first statement names the run:
# pgAudit records it (misc_set), which marks where this run's statements begin in the audit.
PGPASSWORD="$token" PGOPTIONS="$options" PGAPPNAME="db-support:$run" \
  psql "host=$DB_HOST dbname=$DB_NAME user=$DB_USER sslmode=require" \
  -X -1 -v ON_ERROR_STOP=1 -A -F "|" -e \
  -c "SET application_name = 'db-support:$run'" -f "$query" >"$result" 2>&1
status=$?

echo "db-support: run $run finished with psql status $status"
exit "$status"
