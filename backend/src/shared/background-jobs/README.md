# Background Jobs

A shared, in-repo substrate for durable work the worker runs after a request has
answered: conversation summary refresh, Slack inbound-event dispatch, and any
kind a module registers. A job is a row in Postgres; a Cloud Task or the
worker's poll loop only wakes a worker to look. The substrate knows job kinds,
payload schemas, leases, deadlines, retries, and dead letters, and nothing
about conversations, channels, or any other product concept.

Start here when work needs to survive a deploy, a scale-in, or a Cloud Run
instance losing CPU after its response, and would otherwise run as a detached
promise in the API process.

## Boundaries

The substrate owns:

- `defineBackgroundJob`: a kind's name, zod payload schema, duplicate-key mode
  (`onDuplicateKey`), and policy (`maxAttempts`, `leaseSeconds`,
  `timeoutSeconds`, `retryBaseDelaySeconds`, and optionally `retryDelaysSeconds`
  — see Retries below).
- `backgroundJobRequest`: a validated job to write, with an optional
  `idempotencyKey` and `runAfter`.
- `backgroundJobHandler`: the function that runs one kind. It receives the
  parsed payload and `{ jobId, attempt, signal }`, resolves with a
  `BackgroundJobSkipped` to mean "done, but delivered nothing by design," and
  takes optional `onAttemptFailed` and `onDeadLetter` hooks.
- `BackgroundJobQueue`: the producer port. `enqueue` resolves once the job is
  stored and wakes a worker without the caller waiting on it;
  `enqueueInTransaction` writes inside the caller's transaction, and the caller
  calls `wake()` once that transaction commits.
- `BackgroundJobRuntime`: claims a due job under a lease, runs its handler while
  renewing the lease, then deletes it, requeues it for a requested rerun,
  retries it with a doubling (or explicit) backoff, or dead-letters it.
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
- `backend/src/modules/facets/infra/facetExtractionBackgroundJobStore.ts`: a
  module-owned store. Per-message facet extraction runs its own
  `facet_extraction_jobs` table through this runtime instead of
  `background_jobs`, because the table's rows stay readable after completion
  (coverage reads, backfills) and nothing is deleted on success. Audience
  Pulse's workspace-scoped batch drain stays on its own path over the same
  table — the generic claim filters by kind only, not by workspace or message
  window, so a bespoke store adapter is one way to bridge an existing queue
  onto this runtime without a data migration, but it cannot express every
  access pattern the queue it replaces had.

The action outbox (#1509) runs on this runtime too, over its own table:
`backend/src/db/repositories/actionRequestRepository.ts` implements
`BackgroundJobStore` over `routine_action_requests`, with no schema change —
the fencing token is the row's own `attempts`, and the lease is the staleness
of `updated_at`. One job kind, `chat.action_dispatch`, carries every action
`type` (the real routing value travels inside the job's payload, since the
table has no `kind` column); `backend/src/modules/chat/services/actions/
actionDispatchJob.ts`'s `createActionDispatchJobHandler` resolves it against
the existing `ActionHandlerRegistry` and reproduces the outbox's own retry
contract through the port growth above: a flat 60 s `retryDelaysSeconds`,
`onAttemptFailed`/`onDeadLetter` for the handler's two
`recordFailureOutcome` outcomes, and a handler-returned `skipped` result for
a transport that deliberately delivers nothing. `ActionHandler`
implementations did not change.

## Semantics

- **Duplicate keys, per kind.** Every kind declares what an enqueue does when a
  job with the same kind and `idempotencyKey` is still waiting or running:
  - `ignore` (one-shot): the duplicate is a no-op. Use it when the key names
    one unit of work, such as an inbound event id.
  - `rerun` (level-triggered): a duplicate that arrives while the job is
    running marks it to run once more, because the run may have read state the
    duplicate's change postdates; completion then returns the job to waiting
    instead of deleting it. A duplicate of a job that has not started is folded
    into it, and that job cannot be claimed until the producer's transaction
    ends. Use it when the job recomputes from current state, and only when the
    payload is fully determined by the key: a rerun runs the stored payload.

  In both modes the key is free again once the job completes or is
  dead-lettered. Durable deduplication beyond a live job (an event id seen last
  week) belongs to the owning module's own table.
- **Leases, heartbeats, deadlines.** A claim holds the job for the kind's
  `leaseSeconds` under a fresh claim token. While the handler runs, the runtime
  renews the lease three times per lease; a renewal that finds the claim taken
  over aborts the handler's `signal` and the run writes nothing back. The
  kind's `timeoutSeconds` is always shorter than its lease: when it passes, the
  runtime aborts the `signal`, stops waiting, and records a retryable
  `BackgroundJobTimeoutError`. Pass `signal` to provider and database calls; a
  handler that ignores it keeps running in the background, and whatever it
  writes afterwards races the retry. Every complete, retry, and dead-letter
  write is fenced on the claim token. Handlers must be idempotent: a crash
  between a side effect and the job's deletion runs the job again.
- **Claim eligibility is fixed for a whole drain.** A `drain()` call remembers
  every id it has claimed and excludes them from every further claim it makes
  within that same call. Due is still decided by the store's own clock (the
  database's `now()`, for the generic store, never a caller-supplied instant
  that could skew from it) — a job this same call just retried (or a lease it
  just reclaimed) can become genuinely due again before the call ends,
  especially during a long recovery sweep whose other claims take real time to
  run, but the exclusion keeps it from being claimed a second time, even when
  its delay is as short as the facet queue's 1 s first step. It waits for the
  next wake, poll tick, or recovery sweep instead, so one drain can never burn
  a job's whole retry budget on itself.
- **Retries.** A failed run returns to waiting after a delay the kind's policy
  decides, and wakes a worker for that time. The default is doubling:
  `retryBaseDelaySeconds * 2^(attempt - 1)`, capped at an hour — right for a
  provider call whose transient failures cluster. A kind with its own retry
  contract sets an explicit `retryDelaysSeconds` schedule instead (indexed by
  attempt; the last entry repeats past the end of the list) — `[60]` for a flat
  60 s backoff, `[1, 5, 15]` for a three-step one.
  `NonRetryableBackgroundJobError` dead-letters at once, and so does a stored
  payload that no longer matches its schema. A job whose every lease expired
  without finishing is dead-lettered on its next claim past `maxAttempts`.
- **Per-attempt failure hook.** `backgroundJobHandler(kind, handle, {
  onAttemptFailed })` runs `onAttemptFailed(payload, { jobId, attempt,
  idempotencyKey, error, transaction })` once per attempt the runtime is about
  to retry — never the terminal attempt, which goes to `onDeadLetter` instead.
  It runs inside the same write-back that reschedules the retry, fenced the
  same way `onDeadLetter` is: an attempt whose claim was already taken over
  never runs it, and a hook that throws rolls back with the reschedule, which
  is then written again without it. Use it for bookkeeping that must track
  every attempt, not just the kind's eventual outcome (for example, the
  action outbox's per-attempt delivery telemetry). It does not run for an
  attempt lost to a crashed or stalled worker: that attempt's lease simply
  expires and no failure is ever reported for it, so a domain store that
  counts attempts for its own records should count them at claim time, not by
  counting hook calls.
- **What a failure stores and reports.** `last_error` holds the error's class,
  plus an `AppError` code when there is one, for example
  `AppError [provider_unavailable]`. Never the message or stack, which can
  carry provider responses, conversation text, or credentials. The error
  reporter gets the same shape (kind, attempt, job id, that summary) and never
  the error itself. `onAttemptFailed` and `onDeadLetter` additionally get
  `cause`: the underlying error itself (`undefined` for a synthetic failure
  such as a lease that expired with no run to blame). Unlike `error`, the
  substrate never logs, stores, or reports `cause` or anything derived from
  it — it exists only so a handler's hook can make its own bounded,
  structural extraction (a trailing HTTP status code, say) from an error
  that may itself carry a secret in its message, the same trust a handler's
  own `run` already has for the errors it throws. A hook must treat `cause`
  with that same care: never log, store, or report it or its message
  verbatim.
- **Dead letters.** After `maxAttempts` runs, a failure that cannot be retried,
  a payload that no longer parses, or attempts used up by crashed workers, the
  job is parked. The same write drops its payload: a dead letter keeps its kind,
  key, attempts, `last_error`, and timestamps for 14 days, then the retention
  sweep removes it. A rerun requested during a run that ends in a dead letter is
  dropped; the next enqueue starts fresh.
- **Dead-letter hook.** `backgroundJobHandler(kind, handle, { onDeadLetter })`
  runs `onDeadLetter(payload, { jobId, attempt, idempotencyKey, error,
  transaction })` once, inside the transaction that parks the job, whatever
  parked it. `payload` is the parsed payload, or `null` when the stored payload
  no longer parses (the key is still there). Make its writes through
  `transaction` so they commit with the park. The park is fenced on the claim
  token, so an attempt whose claim was taken over never runs it. A hook that
  throws rolls back with its writes; the job is parked without it and the
  failure is reported by shape.
- **Completion.** A completed job is deleted, because a payload can carry
  conversation identifiers or content.
- **Skipped outcome.** A handler resolves `run` with `{ skipped: "reason" }`
  to mean it ran to completion but a configured transport deliberately
  delivered nothing — distinct from an ordinary completion in the drain result
  and metrics (`outcome: "skipped"`), though the generic `background_jobs`
  store has no distinct row state for it and just completes the job as usual.
  A store backing a table with its own terminal "skipped" state (the action
  outbox's `routine_action_requests.status`) records it there instead.

## Time Budget

The numbers below hold together; change them together.

| What | Value | Where |
|------|-------|-------|
| A kind's deadline (`timeoutSeconds`) | at most 240 s; summary refresh 120 s, Slack inbound dispatch 240 s (the handler has no signal to cancel, so the deadline cannot stop it early without risking a duplicate Slack reply) | `defineBackgroundJob`, `BACKGROUND_JOB_MAX_TIMEOUT_SECONDS` |
| A kind's lease (`leaseSeconds`) | longer than its deadline; summary refresh 180 s, Slack inbound dispatch 270 s | `defineBackgroundJob` |
| One drain request's budget, from the request's arrival | 270 s | `BACKGROUND_JOB_DRAIN_BUDGET_SECONDS` |
| Jobs per pushed drain | 1 | `backgroundJobWorkerTaskRoutes.ts` |
| Jobs per recovery sweep | up to 10, while the next job's deadline still fits the budget | `background_job_recovery_max_jobs` |
| Worker request timeout | 300 s | `infra/terraform/compute.tf` (`document_worker`) |
| Cloud Tasks dispatch deadline | 300 s | `cloudTasksBackgroundJobWake.ts` (set per task) |
| Cloud Scheduler attempt deadline | 300 s | `infra/terraform/scheduler.tf` |

A drain claims a job only while that kind's deadline still fits in what is left
of its budget, so a request ends inside 270 s even when every handler runs to
its deadline, and the 30 s above it covers the claim, completion, and
dead-letter writes. The budget is longer than the longest deadline, so a kind
at 240 s still fits a pushed drain after the request spent a few seconds
arriving.
Cloud Tasks and Cloud Scheduler wait as long as the worker does, so neither
retries a drain that is still running. The poll loop has no request around it:
each tick runs up to ten jobs, each under its own deadline.

## How To Add A Job Kind

1. Define the kind in the owning module, next to the code it runs:

   ```ts
   export const MY_JOB = defineBackgroundJob({
     kind: "my_module.my_work",
     payload: z.object({ workspaceId: z.string(), subjectId: z.string() }),
     onDuplicateKey: "ignore", // or "rerun" for a job that recomputes from current state
     maxAttempts: 5,
     timeoutSeconds: 60,
     leaseSeconds: 90,
   });
   ```

   Keep the payload to identifiers the handler can load current state from.
   The kind name is a stored value and a metric label: keep it stable.
   `timeoutSeconds` must be shorter than `leaseSeconds` and at most 240 s.

2. Enqueue through the `BackgroundJobQueue` port composition hands the module:
   `queue.enqueue(backgroundJobRequest(MY_JOB, payload, { idempotencyKey }))`,
   or `enqueueInTransaction(trx, request)` plus `wake()` after commit when the
   job must commit with the caller's own writes.

3. Export a handler factory from the module's composition entry point,
   `backgroundJobHandler(MY_JOB, (payload, { signal }) => service.run(payload, { signal }))`,
   and add it to the handler list `backend/src/app/server/dependencies.ts`
   passes to `backgroundJobs.createRuntime`. The runtime refuses two handlers
   for one kind, and a worker claims only kinds it has handlers for. Let a
   failure the job should retry reject; resolve with nothing when the work is
   done, or `{ skipped: "reason" }` when it ran but a configured transport
   deliberately delivered nothing. When the module has to record that the work
   was given up, pass `{ onDeadLetter: (payload, { idempotencyKey, transaction
   }) => … }` as the third argument and write through `transaction`; to track
   every retried attempt (not just the eventual outcome), add `onAttemptFailed`
   alongside it, with the same shape.

4. Test the handler as business behaviour, and the producer's enqueue with a
   recording queue. `tests/support/inMemoryBackgroundJobStore.ts` gives runtime
   semantics on a controllable clock.

No migration, route, queue, or schedule is needed per kind.

## Observability

Every run records `background_jobs_total{kind,outcome}` (outcome `completed`,
`skipped`, `requeued`, `retried`, `dead_lettered`, or `superseded`),
`background_job_run_duration_ms{kind,outcome}`, and
`background_job_wait_ms{kind}`, a `background_job.run` span with the kind and
attempt, and a log line with the job id, kind, attempt, outcome, duration, and
error class. A dead letter is reported to the error sinks. Wakes count
`background_job_wakes_total{result}`; a failed lease renewal logs a warning.
None of these carry the payload or an error message.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/background-jobs`
- `tests/integration/background-job-repository.integration.test.ts` (Postgres
  store: `SKIP LOCKED` contention, claim-token fencing, lease renewal, reruns
  against a producer's open transaction, retention)
