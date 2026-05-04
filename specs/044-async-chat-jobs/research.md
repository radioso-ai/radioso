# Research: Chat Execution Classes

## Decision: Keep normal chat on the synchronous streaming path

### Rationale

- Radioso's core assistant experience depends on immediate token streaming and live conversational feedback.
- The current authenticated and public chat flows already treat retrieval, answer generation, validation, persistence, and delivery as one interactive request.
- Putting a durable queue in the critical path for normal chat would trade product responsiveness for architecture optics without solving a current user problem.

### Alternatives considered

- Queue every chat turn behind a durable worker: rejected because it would degrade live UX and blur the product boundary between conversation and background work.
- Use queueing only during overload as a fallback: rejected because silent downgrade from live chat to background work would be unpredictable and hard to explain to users.

## Decision: Treat async assistant work as a future explicit deferred product mode

### Rationale

- Long-running analysis, replay, export, or notification workflows may eventually benefit from durability and independence from live request time limits.
- Users and operators can accept deferred completion when the product clearly presents the work as background processing.
- A separate async category gives enterprise reviewers a credible reliability story without forcing all assistant behavior through one execution model before the runtime exists.

### Alternatives considered

- Leave async chat-adjacent work unspecified for later: rejected because the absence of a clear category invites future scope drift and queue-everything pressure.
- Reuse the same UX language for live and deferred work: rejected because it would create false expectations about immediacy.

## Decision: Formalize the policy in code and documentation, not just conversation

### Rationale

- Architecture decisions that live only in chat threads or review comments decay quickly.
- A focused execution-policy seam allows tests and future features to check the approved classification directly.
- Operator and enterprise documentation must explain the service model in plain language so the team does not rely on engineers to interpret it every time.

### Alternatives considered

- Document the decision only in the spec: rejected because the implementation would still lack an enforceable source of truth.
- Keep the policy only in documentation: rejected because future code changes could drift away from the approved execution model unnoticed.

## Decision: Use operator-triggered analysis as the first reference category for future deferred assistant work

### Rationale

- Operator-triggered analysis is non-interactive and resembles background assistant work more than live chat.
- It provides a concrete category for classification without forcing immediate implementation of a generic async chat runtime.
- In this feature it remains future scope, which keeps the documentation honest while still identifying plausible deferred candidates.

### Alternatives considered

- Use normal chat as the reference async workflow: rejected because the approved product model says live chat remains interactive.
- Invent a new background workflow just for the policy: rejected because it would add speculative product scope.
