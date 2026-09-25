# Test Execution Module

Test Execution owns operator-private conversations pinned to immutable agent
revisions. It validates selected context-variable sample values, creates single
or comparison executions, fences turns and retries, and keeps failed sides
independently retryable.

Start at `testExecution.ts`. The HTTP routes are mounted under the agent routes
in `app/http/routes/testExecutionRoutes.ts`; the trusted runner adapter is
`chat/services/trustedTestExecutionRunnerAdapter.ts`. Revision selection belongs
to `modules/agents`; chat remains the runtime port.

A single execution can start from an existing conversation (`seedConversationId`
on start). This module only knows the `TestExecutionSeedSource` port: it receives
an ordered user/assistant thread plus an opaque runner continuation, groups the
thread into turns, and skips the greeting bootstrap because the seed is the
opening. Reading conversations, messages, or routine state belongs to the chat
implementation (`chat/services/conversationTestExecutionSeedSource.ts`); a
missing, other-workspace, or other-agent conversation is one `null`, presented as
404. A comparison cannot be seeded.

`public.ts` exposes the narrow private-test evidence shape Eval may consume to
capture an immutable test-turn snapshot. That Eval shape must not carry
conversation ids, continuations, or turn traces.

Operator Copilot reads and drives Test Chat through the `TestExecutionService`
type `public.ts` exports (`list`, `detail`, `start`, `message`), from
`operatorCopilot/services/testChatService.ts`. It projects bounded copies of
turns and traces for its tools, starts only single-revision executions with
skill effects suppressed, and never reads continuations. This module knows
nothing about the copilot.

Test histories and sample values are never public channel inputs. A published
revision does not make a private test conversation resumable by a visitor.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/test-execution-service.test.ts tests/unit/trusted-test-execution-runner-adapter.test.ts tests/unit/conversation-test-execution-seed-source.test.ts tests/unit/test-execution-request-schema.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/test-execution-routes.integration.test.ts tests/integration/conversation-test-execution-seed-source.integration.test.ts --no-file-parallelism`
