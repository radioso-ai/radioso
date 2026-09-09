# Eval Module

Eval owns durable case authoring and replay. Revision eval runs are a separate
aggregate in `services/revisionEvalRun.ts`: they freeze candidate, case, input,
and policy provenance, track partial comparison state, and retry only failed
cases without changing completed evidence.

Start at `routes/revisionEvalRoutes.ts` and
`db/repositories/revisionEvalRunRepository.ts`. The existing case/run routes
continue to use `services/evalRunService.ts`; revision evidence does not write
the ordinary `eval_runs` or `eval_cases.last_run_id` records.

No document-worker or AMQP payload is added. Revision eval dispatch is created
durably in Postgres and recovered through the run service's lease/retry path.
The run-row claim lock admits one unexpired case lease per run, so GET recovery
polling cannot multiply provider work across processes. Expired leases are
reclaimed with a higher fence; failed cases require the explicit retry route.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/revision-eval-run-service.test.ts tests/unit/eval-run-service.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/revision-eval-run-repository.integration.test.ts --no-file-parallelism`
