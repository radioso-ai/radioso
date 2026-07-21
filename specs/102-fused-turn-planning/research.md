# Research: Fused Turn Planning

## Decision: Host-side plan-then-apply

**Rationale**: The fused inputs span product-owned routine, directive, language,
and retrieval concerns. Keeping the engine unchanged preserves its neutral
contract and uses its existing narrow ports.

**Alternatives considered**: An engine-owned planner port would make the reusable
engine aware of Radioso policy. Rescheduling the engine would expand risk in a
recently changed turn spine.

## Decision: One strict JSON-in-text chat-tier call

**Rationale**: The provider-neutral completion interface does not expose a common
structured-output contract. Strict parsing and semantic candidate validation
provide a portable all-or-nothing boundary.

**Alternatives considered**: Provider-native structured output would require a
new cross-provider abstraction. A new model capability would add rollout and
configuration surface without evidence it is needed.

## Decision: Owning modules prepare and apply decisions

**Rationale**: Candidate eligibility and policy already have clear owners.
Exposing prepare/apply seams allows the middle classification call to be swapped
without duplicating policy in chat orchestration.

**Alternatives considered**: Preparing candidates in `ChatService` would leak
routine and directive rules into a broad orchestration file.

## Decision: Complete staged fallback

**Rationale**: A failed plan must not suppress behavior. Reusing the current port
implementations makes fallback behavior explicit and testable.

**Alternatives considered**: Partially accepting planner fields could combine
inconsistent routing, language, routine, and directive judgments.

## Decision: Environment rollout and offline replay

**Rationale**: A kill switch and workspace allowlist support a low-risk rollout.
Workbench replay exercises the real composition without doubling live model work.

**Alternatives considered**: Live shadow planning adds cost and can complicate
usage attribution. Database/UI rollout is unnecessary for the first release.
