# US1.5 + US2 Contract — Ambient copilot, entity-linked activity, guidance readers

Fixed contract for parallel backend/frontend implementation. Extends
`us1-api-contract.md`; everything there remains valid. Backward compatible:
US1 clients keep working.

## 1. Page context v2 (`POST /api/v1/copilot/turns`)

`pageContext` grows; existing fields keep their meaning:

```json
{
  "view": "activity|history|agent|documents|workbench|quality|evals|copilot|other",
  "agentId": "uuid|null",
  "conversationId": "uuid|null",
  "selection": "string|null",
  "entities": [
    { "type": "agent|conversation|routine|directive|document|evalCase", "id": "string", "label": "string", "focused": true }
  ]
}
```

- `selection`: operator-selected text captured at summon time. Backend
  truncates to 2000 chars. Injected as quoted operator-provided data.
- `entities`: what is currently rendered on the operator's screen, captured
  from the frontend entity registry. Max 30 (backend rejects more), `label`
  max 120 chars, `focused` marks the expanded/selected entity (at most 3).
- `view` gains `"copilot"` for the full-page copilot view.
- Backend injects the structured context as data, never as instructions, and
  the prompt template explains it ("what the operator is viewing").

## 2. Entity-linked activity

The SSE `activity` event and the persisted `activity` entries on copilot
messages gain an optional entity reference:

```json
{ "toolCallId": "…", "tool": "Reading conversation trace", "stage": "completed",
  "entity": { "type": "conversation", "id": "uuid" } }
```

- `entity` is present when the tool read one identifiable entity (agent
  config, routine, conversation trace); absent for searches.
- Persisted form on `GET /conversations/:id` messages: `activity: [{ tool,
  outcome, entity? }]`.
- Frontend renders a "Read during this turn" chip row from these; chips open
  the matching surface (conversation drawer, agent view, routine editor).
  Labels are resolved frontend-side; the backend ships type+id only.

## 3. US2 read-tool families (backend)

Three new family readers, same descriptor port and filtering as US1:

| tool | UI label | permission | reads |
|---|---|---|---|
| `eval_results` | "Reading eval results" | `workspace.retrieval.query` | eval cases/runs and outcomes for an agent (bounded, newest first) |
| `quality_signals` | "Reading quality signals" | `workspace.quality.read` | quality/needs-attention summary for the workspace |
| `audience_topics` | "Reading audience topics" | `workspace.quality.read` | latest stored Audience Pulse census results (never triggers analysis) |

All results pass through size bounding (same posture as
`boundConversationPayload`; shared helper welcome). The system prompt's
capability list is updated to include these families.

## 4. Frontend surface (luna scope, no API impact)

- Copilot becomes a slide-over panel mounted at the dashboard shell, available
  on every view: persistent top-bar button + keyboard shortcut (Cmd/Ctrl+J).
  Panel state (open conversation, streaming turn) survives navigation. The
  `/copilot` page renders the same component full-screen.
- Entity registry: shared provider + `useCopilotEntity(type, id, label,
  focused?)` hook wired into the shared entity-rendering primitives
  (conversation rows/drawer, agent selection, routine cards, eval cases,
  trace stages). Registry feeds `pageContext.entities` at turn time.
- Selection capture: selecting text inside the dashboard shows a small "Ask
  Copilot" affordance; summoning with a selection quotes it in the composer
  and sends it as `pageContext.selection`.
- Polish: contextual suggested-question chips on empty state, activity
  timeline that collapses to a summary when the turn completes, retry action
  on failed/budget-exhausted turns, context rail shows resolved names not
  UUIDs, delete confirmation, relative timestamps.

## 5. Catalog coverage check (FR-019, backend)

A unit test (sibling of `architecture-boundaries.test.ts`) loads the OpenAPI
document and a mapping file `backend/src/modules/operatorCopilot/
catalogCoverage.ts` in which every control-plane `operationId` is either
mapped to a catalog tool name or excluded with a stated reason. Unmapped
operations fail the test. `AGENTS.md` gets one line: operator-facing features
ship a copilot tool descriptor or a coverage-map exclusion in the same change.
