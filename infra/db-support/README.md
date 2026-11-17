# Engineer database access

When you need to read or fix data on a hosted stack, run the SQL through that stack's db-support
job. The job signs in to Postgres as the stack's db-support service account. pgAudit records
every statement it runs, and Cloud Run records who started each run, so every engineer query
leaves a trail that shows who ran what, and when. Query results go back to your terminal only;
they never pass through the log buckets.

## Run a query

```sh
infra/db-support/db-support.sh query live-eu ./count-documents.sql
infra/db-support/db-support.sh query live-eu ./fix-booking.sql --write
```

The script works in four steps:

1. It uploads the file to the stack's results bucket under a fresh run id.
2. It runs `radioso-<stack>-db-support` with that run id and waits.
3. It prints the result.
4. It deletes the run's folder. The bucket deletes anything older than a day in case a run stops
   early.

Each run is read-only unless you pass `--write`. Output is unaligned, one row per line, with
fields separated by `|`, and every statement is echoed above its rows.

Reach rows by id where you can. The statement text, `WHERE` clause included, is kept in the
audit record for 12 months, so `WHERE visitor_id = '…'` keeps an email address out of it and
`WHERE email = '…'` does not. Treat a printed result as customer data. Keep it out of issues,
chats and shared notes, and delete local copies once you're done.

Running a query needs `run.jobs.runWithOverrides` on the job and object access to the results
bucket. Project owners hold both. To give a named engineer access, grant those two on the
stack's job and results bucket:

```sh
gcloud run jobs add-iam-policy-binding radioso-live-eu-db-support --region=europe-west1 \
  --project=radioso-494120 --member=user:<email> --role=roles/run.jobsExecutorWithOverrides
gcloud storage buckets add-iam-policy-binding \
  gs://radioso-494120-radioso-live-eu-db-support-results \
  --member=user:<email> --role=roles/storage.objectUser
```

People are granted by hand rather than listed in Terraform, because this repository is public.

## What is recorded

| Record | Where | Kept |
| --- | --- | --- |
| Who started each run, with its run id | Cloud Run Admin Activity audit log, in the project's `_Required` bucket | 400 days |
| Each statement the db-support user ran: the statement text, never its rows | `radioso-<stack>-db-access` bucket in the stack's region | 12 months |
| Each IAM sign-in to the instance | The same bucket | 12 months |

The run id ties a run to its statements: it is the job execution's first argument, and the
session's `application_name` is `db-support:<run id>`. To read who ran what on live-eu over the
last month:

```sh
gcloud logging read 'resource.type="cloud_run_job"
  AND resource.labels.job_name="radioso-live-eu-db-support"
  AND protoPayload.methodName:"RunJob"' \
  --project=radioso-494120 --freshness=30d \
  --format='table(timestamp, protoPayload.authenticationInfo.principalEmail)'

gcloud logging read \
  'protoPayload.request.@type="type.googleapis.com/google.cloud.sql.audit.v1.PgAuditEntry"' \
  --project=radioso-494120 --bucket=radioso-live-eu-db-access --location=europe-west1 \
  --view=_AllLogs --freshness=30d
```

Reading the bucket needs `logging.views.access`, which Private Logs Viewer holds.

`setup.sql` turns auditing on for every role that connects to the `radioso` database except the
application's own user, `radioso`. That keeps the record limited to people, and a login added
later is audited from its first session. The application's user still reaches the database, and
`db-support.sh setup` runs as it. Its sessions leave no pgAudit record, so the Admin Activity log's
record of the setup job is the trail for those.

## Turn it on for a stack

1. **Apply the foundation root** for the environment (`../terraform/foundation`). It adds:
   - the `radioso-<env>-db-support` service account and its Cloud SQL sign-in role;
   - the `radioso-<env>-db-access` bucket; and
   - the sink that fills the bucket.

   pgAudit records are Data Access audit entries, and the environment that owns the project's
   services turns those on for Cloud SQL. `live` owns them for the project it shares with
   `live-eu`, so apply `live`'s foundation first.
2. **Set `db_support_access_enabled = true`** in the environment root's `variables.tf` and run the
   Terraform workflow for that stack. This **restarts the database**: turning on pgAudit takes a
   restart, and a single-zone instance has no database for the few minutes that takes. Chat
   turns and worker jobs fail meanwhile. Run it in the stack's maintenance hour.
3. **Run the one-time setup:**

   ```sh
   infra/db-support/db-support.sh setup live-eu
   ```

   It runs `setup.sql` as the application's user from a throwaway job, then prints what it set:
   the pgAudit settings, the `radioso_support` group role, its table grants and its member. It
   is safe to run again.
4. **Check both halves.** Run a query, then read the audit bucket for it:

   ```sh
   echo 'SELECT current_user, count(*) FROM schema_migrations;' > /tmp/check.sql
   infra/db-support/db-support.sh query live-eu /tmp/check.sql
   ```

   The query prints the db-support user's name and a count. A `PgAuditEntry` for it reaches the
   `radioso-live-eu-db-access` bucket within a few minutes.

## Common failure modes

- **`password authentication failed for user "radioso-<env>-db-support@<project>.iam"`.** Either
  the foundation root hasn't granted the sign-in role, or `db_support_access_enabled` is off on
  the stack.
- **`permission denied for table …`.** Setup hasn't run on this stack. Or a role other than
  `radioso` created the table, so the default privileges skipped it. Grant it by hand as
  `radioso`.
- **`cannot execute UPDATE in a read-only transaction`.** The run was read-only. Add `--write`.
- **The query works but the bucket stays empty.** Data Access audit logs for Cloud SQL are off in
  the project. Apply the foundation of the environment that owns the project's services.
- **`db-support: run … wrote no result`.** The job stopped before running psql. Read the
  execution's log in the Cloud Run console. It prints only the exit status and the reason.
