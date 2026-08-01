# Contract Design: Skill Slot Filling

## Public package contract

`@radioso/conversation-contract` changes `SkillDefinition.inputSchema` from
`unknown` to a normalized skill-field declaration. This is intentionally a
breaking TypeScript change: producers must provide the declared scalar form or
omit it; they cannot pass raw JSON Schema.

The contract adds a narrow `ConversationSkillInputResolver` port. The engine
passes it an already selected skill and immutable turn snapshot; it returns one
of ready canonical input, needs-input field reports, or a safe failure. The
contract also adds `awaitingSkillInput` to `ProcessTurnResult` and the stream's
embedded final result.

## Behavioural protocol

```text
selector -> selected skill list
        -> resolver for every selection, same immutable snapshot
        -> all ready: dispatcher loop -> composer
        -> any needs/failed: no dispatcher -> ordinary composer -> result
```

No HTTP endpoint, backend OpenAPI registry, generated OpenAPI artifact, SDK
endpoint, AMQP payload, document-worker dispatch, retry policy, queue test, or
queue documentation changes. The contract is consumed only by the packages in
this slice.

## Tools compatibility migration

`ConversationToolDefinition.inputSchema` remains `unknown` transport data for
MCP/OpenAPI tool listing. `toolToSkillDefinition` must omit that property when
creating a `ToolSkillDefinition`. This is not a projection contract: automatic
MCP/OpenAPI JSON Schema conversion is intentionally deferred.

## Non-goals

No persistence or resumption protocol; no dashboard/editor model; no backend
schema projection; no nested/array fields; no routine-step filling; no cross-skill
same-turn extraction dependency.

