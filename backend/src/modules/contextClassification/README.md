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
  variables, from the revision it is pinned to, with the conversation's own
  values; and definitions by id for Test Chat.
- `ConversationValueWriter` (context-variables): every write, under the
  overwrite rule. The classifier fills an empty value or replaces its own; a
  value the API, a teammate or a routine set stays. Its `null` clears only its own
  value, and an unchanged answer writes nothing.
- `ConversationExcerptReader`, defined here and implemented by chat
  (`chat/services/contextClassificationExcerptReader.ts`): the rolling summary and
  the visitor's latest messages, never a message of a turn whose routine held a
  sensitive slot.
- `ClassificationInferenceFactory`: the workspace's `rewrite` model, metered
  through the usage events every model call records (`surface:
  context_classification`).

Exposed:

- `contextClassificationRequest`, the job request chat writes in a turn's commit
  when the conversation's revision classifies something
  (`chat/services/turnBackgroundJobs.ts`).
- `ConversationClassifier.classifyNow`, which the job's handler calls.
- `classifyTranscript`, for Test Chat: its private test conversations are not
  stored, so the trusted runner hands over the side's transcript, the values the
  test holds and a writer over them (`chat/services/testChatClassification.ts`).

Composition builds the service and registers `contextClassificationHandler` in
`app/composition/backgroundJobHandlers.ts` (`app/composition/contextClassification.ts`).

## A run

1. Read the targets. A variable the classifier may not fill (no longer a Choice,
   or made sensitive or signed since), or one with no active option, is dropped.
   A variable whose value another writer holds is left out of the call. When
   every one is held, no call is made (`skipped_override`).
2. Read the excerpt. When every recent visitor message was withheld as sensitive
   and there is no summary, no call is made (`skipped_sensitive`).
3. One call, with positional fields (`attribute_1`…) so a variable's name never has
   to be a schema property. Each field is an enum of the active keys or null.
4. A key outside the schema fails the run (`invalid`); a failed call fails it
   (`failed`). Either fails the job, which retries and dead-letters under the
   shared runtime.
5. Each answer goes through the writer, with `writtenBy: classifier` and the
   prompt version (`CONTEXT_CLASSIFICATION_PROMPT_VERSION`) as its reference.

The job (`context.classification`) is keyed by conversation with
`onDuplicateKey: "rerun"`: a burst of turns folds into one waiting run, and a
turn that lands mid-run causes one more. A value is visible from the next turn.

## Observability

- `radioso_context_classification_runs_total{trigger, outcome}`: trigger
  `after_turn | test_chat`; outcome `written | unchanged | no_option |
  skipped_sensitive | skipped_override | skipped_empty | invalid | failed`.
- `radioso_context_value_writes_total{writer, outcome}`, counted by the
  context-variables writer.
- One span per run, `context_classification.run`, with the trigger, the recipe
  version, the outcome and counts of variables, writes, clears and kept values.
- A failed run logs its outcome and error type.

None of them carries a value, an option key, a prompt or visitor text.

## Focused checks

- `cd backend && pnpm exec vitest run tests/unit/context-classification.test.ts tests/unit/context-variable-conversation-value-writer.test.ts tests/unit/context-classification-excerpt-reader.test.ts tests/unit/test-chat-classification.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/classified-context-variables.integration.test.ts tests/integration/context-classification-excerpt.integration.test.ts --no-file-parallelism`
