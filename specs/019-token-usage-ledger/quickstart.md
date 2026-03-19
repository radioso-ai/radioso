# Quickstart: Model Token Usage Tracking & Account Summaries

**Feature**: 019-token-usage-ledger | **Date**: 2026-03-19

## Prerequisites

- Node.js 22 and npm installed
- PostgreSQL running with the usage-tracking migration applied
- Backend and frontend dev servers running

## What Changes

### Backend

1. Add a usage ledger and account-daily summary tables plus repositories.
2. Instrument OpenAI-backed chat, rewrite, rerank, and embedding flows so provider-reported token usage is surfaced to a dedicated usage capture service.
3. Extend chat history detail to include turn-level usage totals and per-operation breakdowns for assistant turns.
4. Add a session-authenticated account usage endpoint that returns current-day totals, recent daily rows, and monthly summaries.

### Frontend

5. Add a `usage` dashboard section and a Usage entry in the bottom-left account menu.
6. Add an account-wide Usage view showing today, current month, daily trend rows, and monthly totals.
7. Extend the chat history debug drawer to show usage totals and breakdown rows with explicit "usage unavailable" states.

## Manual Validation

### Scenario 1: Chat turn usage appears in history

1. Create/upload at least one document and complete a chat turn.
2. Open History and inspect the assistant response debug section.
3. Verify prompt/completion/total tokens are shown for the turn and that breakdown rows exist for contributing operations.

### Scenario 2: Account usage aggregates across workspaces

1. Generate chat or document-processing activity in Workspace A.
2. Switch to Workspace B and generate more activity.
3. Open the bottom-left account menu and select Usage.
4. Verify the Usage screen shows combined totals for both workspaces.

### Scenario 3: Usage route does not disturb active workspace

1. Select a non-default workspace.
2. Open Usage from the account menu.
3. Navigate back to a workspace-scoped screen.
4. Verify the previously active workspace is still selected.

### Scenario 4: Historical totals survive workspace deletion

1. Generate usage in a secondary workspace.
2. Delete that workspace.
3. Re-open Usage from the account menu.
4. Verify historical daily/monthly account totals for the deleted workspace's activity remain visible.

## Suggested Commands

```bash
# Focused backend validation
cd backend && npm test -- tests/unit/usage-capture.service.test.ts tests/unit/usage-summary.service.test.ts tests/contract/chat.contract.test.ts tests/contract/account-usage.contract.test.ts tests/integration/account-usage.integration.test.ts

# Optional persistence coverage when a real integration database is available
cd backend && INTEGRATION_DATABASE_URL=postgres://... npm test -- tests/integration/persistence.integration.test.ts

# Frontend validation
cd frontend && npm run build
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```

## Latest Verification Notes

- Focused backend validation passed on the feature branch:
  `tests/unit/usage-capture.service.test.ts`,
  `tests/unit/usage-summary.service.test.ts`,
  `tests/contract/chat.contract.test.ts`,
  `tests/contract/account-usage.contract.test.ts`,
  `tests/integration/chat.integration.test.ts`,
  and `tests/integration/account-usage.integration.test.ts`.
- `tests/integration/persistence.integration.test.ts` remains environment-gated and was skipped in this workspace because `INTEGRATION_DATABASE_URL` was not set.
- Frontend production build passed, `npx tsc --noEmit` passed, and `npm run lint` reported one pre-existing warning in `frontend/lib/workspace-context.tsx` for an unused `clearWorkspaceStorage` symbol.
