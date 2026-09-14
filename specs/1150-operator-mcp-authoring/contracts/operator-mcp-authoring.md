# Contract: Confirmed Operator MCP Authoring

The protected-resource metadata and consent flow advertise `operator:write` in
addition to the existing read, probe and proposal scopes. Existing grants do
not acquire it.

Preparation tools require `operator:propose` and return a bounded reviewed
artifact: target, before/after effect, diagnostics, draft/live impact, expiry,
digest and execution identity. They do not mutate serving configuration.

Execution tools require `operator:write`, `workspace.agents.manage`, an active
bound reviewed operation and its exact digest. The trusted client calls them
only after conversational confirmation. The server validates the binding and
current target fences and returns a reconciliable outcome. Cancellation and
outcome reads require the originating binding but do not execute a mutation.

Publication preparation and execution are distinct tool actions. Publication
uses the same `operator:write` scope, but a separate reviewed candidate and
confirmation.
