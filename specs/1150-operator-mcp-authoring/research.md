# Research: Confirmed Operator MCP Authoring

## Decisions

### Reviewed artifacts bind execution

- Decision: Reuse the shared proposal as the reviewed operation and the Operator MCP invocation receipt as its principal/client/workspace-bound execution identity. Extend those ledgers only with the missing review digest, expiry/cancel, execution link/fences and safe reconciliation reference.
- Rationale: a client-side conversational confirmation can be honored without pretending the server sees a human. The server can nevertheless reject replay, substitution and stale execution and reconcile a lost response.
- Alternatives considered: executing a generic proposal by id. Rejected because existing proposal cards do not encode confirmation, client binding, every target fence, cancellation, or a publication candidate.

### Reuse invocation/proposal ledgers; recover after an uncertain write

- Decision: reuse `operator_mcp_invocations` for grant-scoped operation-id deduplication, call-input digest, proof consumption, claim and safe outcome; reuse `copilot_proposals` for reviewed payload/version, cancellation/expiry and preparation recovery. Add only the fields those two ledgers lack. A claimed operation is never converted to a retryable failure after an uncertain domain call: each owner provides an already-applied/reconcile check keyed by its exact fence/effect before an outcome is finalized.
- Rationale: a process can die after an owning mutation commits but before an invocation receipt records completion. Retrying a generic failed operation could duplicate creates, deletes or releases.
- Alternatives considered: a second full operation broker or failed-then-retry lifecycle. Rejected because the former duplicates known durable state and the latter cannot prove an earlier effect did not land.

### `operator:write` is a new scope and descriptor shape remains `act`

- Decision: Add `operator:write` to the contract, consent and database scope constraints; write descriptors use the existing act shape and require a reviewed-operation identity/digest.
- Rationale: the user explicitly rejected a distinct publication permission. The new scope expresses consent to trusted-client confirmation while domain permission remains `workspace.agents.manage`.
- Alternatives considered: reuse `operator:act`. Rejected because existing act grants must not silently gain confirmed authoring authority.

### Explicit routine transforms reuse canonical validation

- Decision: define a typed transform input that identifies edges/steps/ordinals explicitly, projects before/after connections in review, and delegates final validation to the routine owner.
- Rationale: stored graph targets cannot express an adjacency-intent distinction. Explicit transforms avoid silent rewiring.
- Alternatives considered: dashboard-style positional inference. Rejected by the spec's deterministic transform contract.

### Retrieval mutations are agent-scoped patch writes

- Decision: inspect system defaults as code-owned/read-only, expose the existing agent retrieval override and apply omission-preserving patches at its existing lifecycle.
- Rationale: avoids inventing workspace defaults and preserves fields outside a requested patch.

### Publication candidates are immutable reviews

- Decision: candidate preparation snapshots the draft generation and current publication revision; publication rechecks both fences before delegating to the agent revision owner.
- Rationale: application and release are distinct actions and existing conversations remain pinned by the existing revision behavior.

## Integration Review

- Queue/AMQP: no new handoff or payload. Existing owning services retain responsibility for any established downstream effects.
- Observability: audit operation lifecycle transitions with safe IDs/reason vocabulary; no customer config/content or credentials.
- Public contracts: regenerate OpenAPI and SDK snapshots if backend routes/schemas change; regenerate MCP package OpenAPI types after backend OpenAPI generation.
