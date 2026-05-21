# Data Model: Conversation Modes

## Conversation Mode

- **Represents**: The workspace-scoped setting that controls how broadly the
  assistant responds after grounding has been established for a turn.
- **Fields**:
  - `mode`: one of `factual`, `guided`, `exploratory`
  - `defaulted`: whether the value came from the system default
- **Validation rules**:
  - only the three approved values are valid
  - older settings payloads that omit the field resolve to `guided`
- **Relationships**:
  - stored as part of workspace retrieval settings
  - applies to authenticated and public/anonymous chat paths that use workspace
    retrieval settings

## Focused Continuation

- **Represents**: A short optional grounded extension used mainly by guided mode.
- **Fields**:
  - `items`: zero to two adjacent grounded directions
  - `sourceContextIds`: references to the turn’s grounded contexts
  - `applied`: whether the continuation was included in the final answer
- **Validation rules**:
  - must be omitted entirely if no honest adjacent direction is supported
  - must stay closely related to the direct answer topic
  - must remain clearly optional rather than sounding like part of the direct
    answer

## Expansive Continuation

- **Represents**: A broader grounded discovery block used by exploratory mode.
- **Fields**:
  - `avenues`: two to three grounded areas worth exploring next
  - `followUpQuestion`: optional grounded prompt for continuing the
    conversation
  - `sourceContextIds`: references to the turn’s grounded contexts
  - `applied`: whether expansive content was included in the final answer
- **Validation rules**:
  - avenues must come only from grounded material already available for the turn
  - the follow-up question must be omitted if it cannot be supported honestly
  - expansive content must remain clearly separated from the direct answer

## Conversation Strategy Metadata

- **Represents**: Stored or presented debug metadata that explains how
  conversation mode shaped a turn.
- **Fields**:
  - `conversationMode`
  - `expansionApplied`
  - `focusedItemCount`
  - `expansiveItemCount`
  - `followUpQuestionApplied`
  - `brevityOverrideApplied`
- **Validation rules**:
  - `conversationMode` should always be present for retrieval-backed answers
    after this feature ships
  - counts must reflect only content actually delivered to the user
- **Relationships**:
  - additive to existing assistant-turn audit metadata and history/debug views

## Mode-Shaped Turn

- **Represents**: The final delivered assistant turn after combining direct
  answer content, citation-aware presentation, and any optional focused or
  expansive continuation.
- **Fields**:
  - `answer`
  - `citations`
  - `answerSegments`
  - `conversationStrategyMetadata`
  - `answerOutcome`
  - `validation`
- **State rules**:
  - `factual` usually produces no optional continuation
  - `guided` may produce a focused continuation
  - `exploratory` may produce an expansive continuation
  - support-policy handling still governs what happens to unsupported
    substantive content before final delivery
