# Runs inside the db-support Cloud Run job (../terraform/db_support_access.tf) as `sh -c`, with the
# run id and mode as $1 and $2. The query is read from, and the result written to, the run's folder
# in the results bucket mounted at /results, so neither reaches the job's log. Only the exit
# status is printed.

run="$1"
mode="$2"

case "$run" in
  "" | *[!a-z0-9-]*)
    echo "db-support: the run id must be lowercase letters, digits and dashes"
    exit 2
    ;;
esac

dir="/results/$run"
if [ ! -f "$dir/query.sql" ]; then
  echo "db-support: run $run has no query.sql"
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

# Read-only unless the engineer asked for a write. The audit records either way.
options="-c default_transaction_read_only=on"
if [ "$mode" = "write" ]; then
  options=""
fi

PGPASSWORD="$token" PGOPTIONS="$options" PGAPPNAME="db-support:$run" \
  psql "host=$DB_HOST dbname=$DB_NAME user=$DB_USER sslmode=require" \
  -X -v ON_ERROR_STOP=1 -At -F "|" -e -f "$dir/query.sql" >"$dir/result.txt" 2>&1
status=$?

echo "db-support: run $run finished with psql status $status"
exit "$status"
