# Agent Runtime

A shared, in-repo substrate for tool-calling LLM agents. Hosts the loop, the
typed tool contract, budget enforcement, and trace events. Knows nothing about
any product concept (retrieval, agent wizard, persona, documents).

Start here when adding a new agent surface, changing the tool-calling loop,
adjusting termination semantics, or adding new trace event kinds.

For the spec that defines this substrate and its first consumer, see
[`specs/065-agent-runtime-and-agentic-retrieval/spec.md`](../../../../specs/065-agent-runtime-and-agentic-retrieval/spec.md).

## Boundaries

The runtime knows about:

- A typed tool catalog (`AgentTool<TInput, TOutput>` with Zod schemas) supplied
  per call.
- An LLM tool-calling gateway port (`ModelToolCallingGateway`).
- Per-call budgets (`maxSteps`, `maxToolResultTokens`, `maxWallTimeMs`) with
  defaults and non-overridable hard ceilings.
- Trace events emitted to an optional sink and/or consumed as a stream.
- Termination reasons.

The runtime MUST NOT know about retrieval, chunks, documents, conversations,
persona, response identity, language policy, or any other product concept.
Concrete tools live in the domain module that owns them and are registered
into a per-call catalog.

## Public Surfaces

- `index.ts`: public exports. Domain modules MUST import only from here.
- `types.ts`: contracts (`AgentRuntime`, `AgentTool`, `AgentBudgets`,
  `AgentTraceEvent`, `ModelToolCallingGateway`, etc.).
- `defaultAgentRuntime.ts`: the default tool-calling loop implementation.

The default implementation is wired by `backend/src/app/composition/`. Domain
modules MUST depend on the port (`AgentRuntime`) and never construct the
default implementation directly.

## Termination Reasons

Every run terminates with exactly one reason:

- `completed` — model emitted a final message with no further tool calls.
- `step_budget_exhausted` — `maxSteps` reached.
- `token_budget_exhausted` — cumulative tool-result tokens exceeded
  `maxToolResultTokens`.
- `wall_time_exhausted` — elapsed time exceeded `maxWallTimeMs`.
- `tool_validation_failed` — two consecutive validation failures (unknown
  tool name or invalid arguments) for the same tool.
- `tool_invocation_failed` — the model retried the same tool with the same
  arguments after a thrown invocation error.
- `cancelled` — the supplied `AbortSignal` was triggered.

## Statelessness

The runtime is stateless across calls. Each invocation constructs its own
transcript, budget counters, and validation/invocation-failure trackers. No
global state, no shared memory across concurrent calls.

## Streaming

`runStreaming` returns `{ events: AsyncIterable<AgentTraceEvent>, result }`.
`run` is implemented in terms of the same internal loop and additionally
forwards events to an optional `traceSink`. Both share termination and
budget semantics.

## Tests

Focused starting point:

- `cd backend && pnpm test -- tests/unit/agent-runtime.test.ts`
