# Data Model: Document List Polish

## Entity: Document Row View

- **Purpose**: Frontend projection of account-scoped knowledge-base documents for list rendering and row actions.
- **Fields**:
  - `id: string (uuid)`
  - `title: string`
  - `status: string` (backend lifecycle state)
  - `updatedAt: string (ISO date-time)`
  - `statusView.label: string` (derived, single plain-language status)
  - `statusView.icon: "ready" | "processing" | "failed"` (derived)
- **Validation/Rules**:
  - Must render exactly one status label and one icon.
  - Row layout must stay within viewport width without horizontal page scroll.
  - Long unbroken titles must wrap safely.

## Entity: Document Deletion Command

- **Purpose**: User-confirmed instruction to permanently remove one document owned by the authenticated account.
- **Fields**:
  - `accountId: string (uuid)` from bearer token
  - `documentId: string (uuid)` from route param
  - `confirmedByUser: boolean` (frontend confirmation gate)
- **Validation/Rules**:
  - Server accepts only UUID `documentId`.
  - Server must delete only when `document.account_id === accountId`.
  - Missing/non-owned document returns not found semantics.
  - Success removes document from future list loads.
- **State transitions**:
  - `idle -> confirm_pending -> deleting -> deleted`
  - `deleting -> failed` on API failure, row remains visible
  - `confirm_pending -> idle` on cancel

## Entity: Citation Availability State

- **Purpose**: Result of citation activation in chat when source may have been deleted after answer generation.
- **Fields**:
  - `documentId: string`
  - `availability: "available" | "deleted" | "error"`
  - `message?: string` (user-facing unavailable/error text)
- **Validation/Rules**:
  - `available`: route to document view as usual.
  - `deleted`: show unavailable-source outcome and keep chat context.
  - `error`: show generic open failure while preserving message context.
