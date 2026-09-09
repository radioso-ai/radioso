# Test Execution Module

Test Execution owns operator-private conversations pinned to immutable agent
revisions. It validates selected context-variable sample values, creates single
or comparison executions, fences turns and retries, and keeps failed sides
independently retryable.

Start at `service.ts` and `routes.ts`. The HTTP routes are mounted under the
agent routes in `app/http/routes/testExecutionRoutes.ts`; the trusted runner
adapter is `chat/services/trustedTestExecutionRunnerAdapter.ts`. Revision
selection belongs to `modules/agents`; chat remains the runtime port.

Test histories and sample values are never public channel inputs. A published
revision does not make a private test conversation resumable by a visitor.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/test-execution-service.test.ts tests/unit/trusted-test-execution-runner-adapter.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/test-execution-routes.integration.test.ts --no-file-parallelism`
