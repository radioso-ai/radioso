# Context Classification Module

Context classification fills an agent's classified attributes from the
conversation. An attribute is classified when the agent's enablement of it has
source `classified`: a Choice (`enum`) attribute that is neither sensitive nor
signed. After a turn, one `rewrite`-tier call reads what the visitor wrote and
picks one option for each such attribute, or none.

Start at `conversationClassifier.ts`.

## What it knows, and what it doesn't

It knows the recipe (`backend/prompts/context-classification.md`), how to build a
strict JSON schema from a variable's active options, how to parse the answer,
the job kind and the model tier.

It does not know how values are stored or when one may be replaced, what a
directive, routine or notice is, how a turn runs, facets, or the event log.

## Ports

Consumed:

- `ClassifiedVariableReader` (context-variables): a conversation's classified
  variables, from the revision it is pinned to, with what its ladder holds for
  each; and definitions by id for Test Chat. Its Postgres implementation reads
  the revision through the agents module's `findRevision`, bound in composition.
- `ConversationValueWriter` (context-variables): every write, under the
  overwrite rule. The classifier fills an empty value or replaces its own; a
  value the API, a teammate or a routine set for the conversation stays. Its `null` clears only its own
  value, and an unchanged answer writes nothing.
- `ConversationExcerptReader`, defined here and implemented by chat
  (`chat/services/contextClassificationExcerptReader.ts`): the rolling summary and
  the visitor's latest messages of committed turns, never a message of a turn
  whose routine held a sensitive slot. Such a turn still enqueues a run, so a
  value an earlier run read from it is recomputed without it.
- `ClassificationInferenceFactory`: the workspace's `rewrite` model, metered
  through the usage events every model call records (`surface:
  context_classification`).

Exposed:

- `contextClassificationRequest`, the job request chat writes in a turn's commit
  when the conversation's revision classifies something
  (`chat/services/turnBackgroundJobs.ts`).
- `ConversationClassifier.classifyNow`, which the job's handler calls.
- `readDefinitions` and `classifyTranscript`, for a caller that holds a
  conversation that is not stored, as Test Chat does: it reads the definitions,
  then hands over the transcript, the values it holds, a writer over them and its
  deadline as an abort signal (`chat/services/testChatClassification.ts`). A call
  the deadline aborts ends `skipped_timeout`.

Composition builds the service and registers `contextClassificationHandler` in
`app/composition/backgroundJobHandlers.ts` (`app/composition/contextClassification.ts`).

## A run

1. Read the targets: the enabled `classified` enablements of the revision the
   conversation is pinned to, through the agents module's revision reader, and
   what the conversation's whole ladder (conversation, session, customer, agent,
   workspace) holds for each. A variable the classifier may not fill (no longer a
   Choice, or made sensitive or signed since), or one with no active option, is
   dropped. A variable another writer set for this conversation, its session or
   its customer is held: it is left out of the call, and a conversation value the
   classifier wrote for it is cleared, since it would hide that writer's value.
   When every one is held, no call is made (`skipped_override`). An agent or
   workspace value is a default and holds nothing: the classifier's conversation
   value outranks it, and it applies again once the classifier clears its own.
2. Read the excerpt. When every recent visitor message was withheld as sensitive
   and there is no summary, no call is made (`skipped_sensitive`).
3. One call, with positional fields (`attribute_1`…) so a variable's name never has
   to be a schema property. Each field is an enum of the active keys or null.
4. A key outside the schema fails the run (`invalid`); a failed call fails it
   (`failed`). Either fails the job, which retries and dead-letters under the
   shared runtime. The input budget (`CLASSIFICATION_MAX_INPUT_TOKENS`) holds the
   largest prompt authoring allows, estimated the way the model pipeline does; a
   prompt over it anyway is logged (`context_classification_over_budget`) and
   ends `skipped_over_budget`, without a retry.
5. Each answer goes through the writer, with `writtenBy: classifier` and the
   prompt version (`CONTEXT_CLASSIFICATION_PROMPT_VERSION`) as its reference. A
   write that throws (an option archived mid-run, a database error) is logged
   with its variable id and counted; the other answers are still written, and the
   run then fails so the job retries. A conversation erased mid-run ends the run
   as `skipped_gone`, which is not retried.

The job (`context.classification`) is keyed by conversation with
`onDuplicateKey: "rerun"`: a burst of turns folds into one waiting run, and a
turn that lands mid-run causes one more. A value is usually visible from the next
turn, when the run finishes before the visitor replies.

## Observability

- `radioso_context_classification_runs_total{trigger, outcome}`: trigger
  `after_turn | caller_transcript` (a transcript a caller holds, Test Chat's);
  outcome `written | unchanged | no_option |
  skipped_sensitive | skipped_override | skipped_empty | skipped_gone |
  skipped_over_budget | skipped_timeout | invalid | failed`.
- `radioso_context_value_writes_total{writer, outcome}`, counted by the
  context-variables writer.
- One span per run, `context_classification.run`, with the trigger, the recipe
  version, the outcome and counts of variables, writes, clears and kept values.
- A failed run logs its outcome and error type; a failed write logs its variable
  id and error type (`context_classification_write_failed`).

None of them carries a value, an option key, a prompt or visitor text.

## Focused checks

- `cd backend && pnpm exec vitest run tests/unit/context-classification.test.ts tests/unit/context-variable-conversation-value-writer.test.ts tests/unit/context-classification-excerpt-reader.test.ts tests/unit/test-chat-classification.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/classified-context-variables.integration.test.ts tests/integration/context-classification-excerpt.integration.test.ts tests/integration/context-classification-turn.integration.test.ts --no-file-parallelism`
