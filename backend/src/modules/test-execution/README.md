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

`testExecutionTurns.ts` is the turn read model. It pairs each user message with
its answer, keeps a greeting as a turn with no user message, and takes an
unanswered turn's state and failure code from its highest-fenced attempt.
`TestExecutionService.transcript` reads an execution as those turns per side;
`turn` reads one of them, and right after `message` that is the settled turn.
`summaries` returns a list page with each execution's turn count and opening
message, computed by one repository projection over the first side's history.
These reads leave out continuations, conversation ids, and frozen sample values.

`start` without `revisionIds` runs a single test on the agent's default
revision: a fresh candidate of the saved draft, or the published revision when
the draft matches it. The rule is `AgentRevisionService.resolveDefaultTestRevision`,
reached through `TestExecutionDefaultRevisionPort` and wired in composition. It
is a separate port from the revision reader because choosing can freeze a
candidate, which is a write.

Operator Copilot reads and drives Test Chat through `summaries`, `transcript`,
`turn`, `start`, and `message`, from `operatorCopilot/services/testChatService.ts`,
which adds its spend guard, output bounds, and surface policy. This module knows
nothing about the copilot.

Test histories and sample values are never public channel inputs. A published
revision does not make a private test conversation resumable by a visitor.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/test-execution-service.test.ts tests/unit/trusted-test-execution-runner-adapter.test.ts tests/unit/conversation-test-execution-seed-source.test.ts tests/unit/test-execution-request-schema.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/test-execution-repository.integration.test.ts tests/integration/test-execution-routes.integration.test.ts tests/integration/conversation-test-execution-seed-source.integration.test.ts --no-file-parallelism`
