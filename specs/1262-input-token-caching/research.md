# Research: Provider-Neutral Input Token Caching

## Decisions

### Contiguous internal boundary

**Decision:** Carry an ordered stable leading system prefix and dynamic suffix through inference, retaining roles and exact rendering order.

**Rationale:** The current strings lose where a checkpoint belongs when volatile system material intervenes. One breakpoint permits deterministic rendering while preserving semantics.

**Alternatives considered:** A boolean hint cannot locate a checkpoint. Provider parsing in chat/runtime inverts dependencies. A general message/block rewrite exceeds the pilot.

### Adapter-local capability

**Decision:** Resolve `unsupported`, `implicit`, or `explicit_checkpoint` from selected provider family, model, and API mode/endpoint.

**Rationale:** Support varies by model/endpoint. Keeping it beside adapters avoids a global policy registry and defaults safely.

**Alternatives considered:** Provider-name-only support and composition-level policy are unsafe or misplaced.

### Provider paths

**Decision:** Use native Claude block control only for explicit capability. Gemini implicit capability uses a deterministic compatible ordinary request without a cache object.

**Rationale:** This covers the required pair without lifecycle scope.

### Evidence only

**Decision:** Normalize availability plus optional reads/writes and measure adapter-observable boundaries without changing durable usage schema.

**Rationale:** Missing accounting differs from zero; retention and live performance are provider controlled. Live hit assertions are not deterministic.
