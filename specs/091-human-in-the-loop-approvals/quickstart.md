# Quickstart — exercising HITL Tranche A (Approval MVP)

How to author, run, and test the suspend → decide → resume loop. (`pnpm install` is needed once per worktree — this worktree had no `node_modules`.)

## Author a gated routine

A routine with an approval gate before a side-effecting step:

```
1. Ask the customer why they want a refund.            (chat — collects reason)
2. [approval] Tell the customer the request is under review.
     · captureKey: refund_decision
     · options: approve | reject
     · approve → step 3 ; reject → step 4
3. @issue_refund                                        (skill — the gated side effect)
4. [complete] Explain the refund was declined.
   [complete] Confirm the refund was issued.            (after step 3)
```
The compiler maps `[approval]` → runtime `await`, emits deterministic `field` edges on `refund_decision`, and rejects authoring that violates the invariants (llm decision edge / `collectsSlots` on the gate / gate after the side effect).

## Run the loop (local)

1. `./run-dev.sh` (full stack) — or run backend + worker (`pnpm run dev`, `pnpm run dev:worker`) + frontend.
2. Drive a conversation (dashboard chat, or `POST /api/v1/assistant/chat`) to the approval step.
   - The visitor gets a short "awaiting review" reply.
   - DB: `routine_states.status = 'suspended'`; one `pending_decisions` row (`status='pending'`); the gated skill has **not** run; an `approval.request` outbox row was enqueued and the worker emailed the configured recipient with the handle link.
3. Approve: `POST /api/agents/:agentId/decisions/:handle/resolve` `{ "optionId": "approve", "contentHash": "<from the proposal>" }` as an authorized member — or click **Approve** in the dashboard **Quality → Needs approval** queue.
   - The routine resumes at the gate, `@issue_refund` runs exactly once, the routine completes, `pending_decisions.status='approved'`.
4. Reject instead → the routine takes step 4, the skill never runs, `status='rejected'`.

## What to verify (maps to Success Criteria)

- **SC-001/002**: gated side effect never runs before approval, exactly once after approve, zero on reject (incl. double-submit, redelivery, crash-before-resume, stale-hash).
- **SC-003**: kill the process after the decision row is written but before the resumed turn persists; on retry the human is not re-prompted and resume is idempotent.
- **SC-004**: while suspended, send another visitor message → answered as a normal turn; the suspended routine is not advanced or dropped and is still resolvable.
- **SC-005**: take a conversation from pending → resumed entirely from the dashboard queue (no API client).
- **SC-006**: a non-decider's resolve call is `403` regardless of UI state.
- **SC-007**: every new message has a `source`; old rows read back a role-derived source; no SDK/MCP consumer breaks.
- **SC-008**: the suspension + decision are reconstructable from the trace + `hitl.decision` audit (who/what/when/why) with no raw content.

## Focused tests

```bash
# Engine resume (graduate the spike seed)
cd packages/conversation-engine && pnpm test tests/spike-resume-awaiting-decision.test.ts

# Backend: suspend/atomic-commit, decision endpoint authz + idempotency (real Postgres via INTEGRATION_DATABASE_URL)
cd backend && pnpm exec vitest run tests/integration/approvals/*.test.ts
cd backend && pnpm exec vitest run tests/contract/decisions.contract.test.ts

# Frontend: operator approve→resume journey
cd frontend && pnpm run test:e2e -- approvals.spec.ts

# Local CI before PR
pnpm run ci:local -- origin/main
```
