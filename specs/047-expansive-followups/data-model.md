# Data Model: History-Aware Expansive Suggestions

## Suggestion Group

- **Purpose**: Represents one renderable lane of suggestions associated with a single assistant turn.
- **Fields**:
  - `kind`: categorical value identifying `deeper` or `broader`
  - `label`: optional presentation-facing text if needed later; not required for initial backend contract
  - `suggestions`: ordered list of grouped suggestion items
- **Rules**:
  - Empty groups are omitted from payloads.
  - Exploratory turns may include one or both groups.
  - Guided turns remain eligible only for focused/deeper-style suggestions unless discovery shows a narrower additive contract is sufficient.

## Grouped Suggestion Item

- **Purpose**: A standalone next question that belongs to one suggestion group.
- **Fields**:
  - `text`: the standalone question shown to the user
  - `kind`: `deeper` or `broader`
  - `citation`: existing optional provenance payload linking the suggestion to grounded material
- **Rules**:
  - Text must remain understandable without prior-turn pronouns when clarity would suffer.
  - Text must be in the user’s language.
  - Duplicate or near-duplicate items are filtered before output.

## Conversation Intent Snapshot

- **Purpose**: A transient planning input assembled from recent user/assistant turns to represent the active subject or task for the current turn.
- **Fields**:
  - `recentTurns`: bounded sequence of recent messages used for planning
  - `activeSubject`: optional normalized subject inferred from recent turns or retrieval continuity
  - `activeGoal`: optional short description of the current user task when available
  - `latestQuery`: current user query
  - `latestAnswer`: current assistant answer
- **Rules**:
  - This snapshot is assembled per turn and does not require new persistence.
  - It is only used to steer exploratory grouping, never to bypass grounding.

## Suggestion Provenance

- **Purpose**: Reuses the existing link between a suggestion and the assistant turn plus cited grounded material.
- **Fields**:
  - `suggestionSourceMessageId`: existing click provenance from the UI
  - `citation.documentId`
  - `citation.chunkId`
  - `citation.title`
- **Rules**:
  - Grouping must not remove or weaken provenance already attached to individual suggestions.
