# Background Jobs

A shared, in-repo substrate for durable work the worker runs after a request has
answered: conversation summary refresh today, and any kind a module registers.
A job is a row in Postgres; a Cloud Task or the worker's poll loop only wakes a
worker to look. The substrate knows job kinds, payload schemas, leases, retries,
and dead letters, and nothing about conversations, channels, or any other
product concept.

Start here when work needs to survive a deploy, a scale-in, or a Cloud Run
instance losing CPU after its response, and would otherwise run as a detached
promise in the API process.

## Boundaries

The substrate owns:

- `defineBackgroundJob`: a kind's name, zod payload schema, and policy
  (`maxAttempts`, `leaseSeconds`, `retryBaseDelaySeconds`).
- `backgroundJobRequest`: a validated job to write, with an optional
  `idempotencyKey` and `runAfter`.
- `backgroundJobHandler`: the function that runs one kind.
- `BackgroundJobQueue`: the producer port. `enqueue` writes the job and wakes a
  worker; `enqueueInTransaction` writes it inside the caller's transaction, and
  the caller calls `wake()` once that transaction commits.
- `BackgroundJobRuntime`: claims a due job under a lease, runs its handler, then
  deletes it, retries it with a doubling backoff, or dead-letters it.
- `BackgroundJobStore` and `BackgroundJobWriter`: the ports the runtime and the
  queue write through.

Implementations live outside it, and application composition
(`backend/src/app/composition/backgroundJobs.ts`) wires them:

- `backend/src/db/repositories/backgroundJobRepository.ts`: the generic
  `background_jobs` store (migration `225_background_jobs.sql`).
- `backend/src/shared/infra/cloudTasksBackgroundJobWake.ts`: the Cloud Tasks
  wake, selected by `createDefaultBackgroundJobWake` when
  `WORKER_DISPATCH_DRIVER=cloud-tasks` and `BACKGROUND_JOB_TASK_QUEUE_NAME` is
  set. Otherwise `NoopBackgroundJobWake`, and the poll loop finds the job.
- `backend/src/app/worker/backgroundJobWorkerTaskRoutes.ts`: the drain route
  the Cloud Task and the Cloud Scheduler recovery sweep call, and the
  dead-letter retention sweep route.

## Semantics

- **Idempotency key.** While a job of the same kind and key waits or runs,
  another enqueue with that key adds nothing. Completed jobs are deleted, so the
  key enqueues again afterwards; a dead-lettered job never blocks its key. A
  refresh-style kind keys by its subject: the waiting job reads current state
  when it runs, and a change that commits while one is already running is
  picked up by the next enqueue.
- **Leases.** A claim holds the job for the kind's `leaseSeconds`. A job whose
  lease expires is claimed again by the next drain, and the stale run's
  complete, retry, or dead-letter write is fenced off by the attempt count.
  Handlers must be idempotent: a crash between a handler's side effect and the
  job's deletion runs the job again.
- **Retries.** A failed run returns to waiting after
  `retryBaseDelaySeconds * 2^(attempt - 1)`, capped at an hour, and wakes a
  worker for that time. `NonRetryableBackgroundJobError` dead-letters at once,
  and so does a stored payload that no longer matches its schema.
- **Dead letters.** After `maxAttempts` runs the job keeps its `last_error` for
  14 days, then the retention sweep removes it.
- **Completion.** A completed job is deleted, because a payload can carry
  conversation identifiers or content.

## How To Add A Job Kind

1. Define the kind in the owning module, next to the code it runs:

   ```ts
   export const MY_JOB = defineBackgroundJob({
     kind: "my_module.my_work",
     payload: z.object({ workspaceId: z.string(), subjectId: z.string() }),
     maxAttempts: 5,
     leaseSeconds: 120,
   });
   ```

   Keep the payload to identifiers the handler can load current state from.
   The kind name is a stored value and a metric label: keep it stable.

2. Enqueue through the `BackgroundJobQueue` port composition hands the module:
   `queue.enqueue(backgroundJobRequest(MY_JOB, payload, { idempotencyKey }))`,
   or `enqueueInTransaction(trx, request)` plus `wake()` after commit when the
   job must commit with the caller's own writes.

3. Export a handler factory from the module's composition entry point,
   `backgroundJobHandler(MY_JOB, (payload, context) => service.run(payload))`,
   and add it to the handler list `backend/src/app/server/dependencies.ts`
   passes to `backgroundJobs.createRuntime`. The runtime refuses two handlers
   for one kind, and a worker claims only kinds it has handlers for.

4. Test the handler as business behaviour, and the producer's enqueue with a
   recording queue. `tests/support/inMemoryBackgroundJobStore.ts` gives runtime
   semantics on a controllable clock.

No migration, route, queue, or schedule is needed per kind.

## Observability

Every run records `background_jobs_total{kind,outcome}`,
`background_job_run_duration_ms{kind,outcome}`, and
`background_job_wait_ms{kind}`, a `background_job.run` span with the kind and
attempt, and a log line with the job id, kind, attempt, outcome, duration, and
error type. A dead letter is reported to the error sinks. Wakes count
`background_job_wakes_total{result}`. None of these carry the payload or the
error message; the message is stored on the row as `last_error`.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/background-jobs`
- `tests/integration/background-job-repository.integration.test.ts` (Postgres
  store, `SKIP LOCKED` contention, lease fencing, retention)
