# Data Model: Chat Execution Classes

## Execution Class

- Purpose: Canonical classification for assistant-related workflows.
- Values:
  - `interactive_synchronous`
  - `durable_async`
- Rules:
  - every covered workflow maps to exactly one execution class
  - normal live chat turns cannot be reclassified implicitly during overload or failure handling

## Covered Workflow

- Purpose: Named assistant-related behavior that must be classified by the execution policy.
- Fields:
  - `workflowKey`
  - `displayName`
  - `executionClass`
  - `userExpectation`
  - `notes`
- Initial covered workflows:
  - authenticated live chat
  - anonymous/public chat
  - embedded chat
  - bootstrap greeting generation
  - eval replay
- Rules:
  - live chat surfaces map to `interactive_synchronous`
  - eval replay maps to `interactive_synchronous` in this feature
  - operator-triggered long-running analysis-style work may map to `durable_async` in a future feature with a real background runtime

## Interactive Chat Contract

- Purpose: Product and runtime guarantees for normal conversation turns.
- Expectations:
  - retrieval and answer generation happen in the initiating request
  - streaming may begin before the full answer is complete
  - overload, timeout, or disconnect outcomes stay explicit rather than converting the turn into background work

## Async Assistant Workflow Contract

- Purpose: Required product semantics for future deferred assistant work.
- Expectations:
  - background execution is explicit at start time
  - job state is durable and inspectable
  - completion and failure are surfaced clearly to operators or users
  - the workflow does not require immediate token streaming to deliver value

## Execution Policy Decision

- Purpose: The rule set that maps covered workflows to execution classes and prevents drift.
- Responsibilities:
  - classify current workflows
  - provide a reference point for tests and docs
  - reject silent fallback from `interactive_synchronous` to `durable_async`
