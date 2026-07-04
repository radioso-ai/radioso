# Data Model: Directive Skill Binding

## agent_directives (existing table, one new column)

| Column | Type | Notes |
|--------|------|-------|
| binding | JSONB NULL | `{"kind": "skill", "skillName": string}`; NULL = no binding |

Migration: `backend/src/db/migrations/119_agent_directive_binding.sql` (additive,
nullable, no backfill). Regenerate Kysely types (`pnpm run db:types`) and schema dump
(`pnpm run db:schema`) — both are generated artifacts.

## Contract type (packages/conversation-contract/index.d.ts)

```ts
export interface DirectiveBinding {
  kind: "skill";            // future: "routine" — union extension, no migration
  skillName: string;
}

export interface Directive {
  // ...existing fields
  binding?: DirectiveBinding;
}
```

`DirectiveMatch` is unchanged — it already embeds the full `Directive`.

## Authored directive schema (backend/src/modules/agents/authoredDirectives.ts)

- `binding: z.object({ kind: z.literal("skill"), skillName: trimmedText(200) }).strict().nullable().optional()`
- New limit entry: `bindingSkillName: 200`.
- `AuthoredDirective` + `AuthoredDirectiveConfig` (agentConfig.ts) gain
  `binding: { kind: "skill"; skillName: string } | null`.
- Service-level validation on create/update (NOT in Zod): skill exists on agent,
  enabled, turn-capable invocation mode. Error names the offending skill.
- Import path (agent config materialization) skips service validation.

## Runtime resolution result (new pure module)

```ts
interface DirectiveBindingResolution {
  winner?: { directiveName: string; skillName: string };
  losers: Array<{ directiveName: string; skillName: string }>;
  skipped: Array<{ directiveName: string; skillName: string; reason:
    "skill_not_registered" | "skill_not_enabled" | "skill_not_turn_capable" }>;
}
```

Consumed by `ChatTurnSkillSelector`; winner/losers/skipped feed `SelectionDecision`
(engine trace) and the warn log for skips.

## API surface

- `AuthoredDirective*` request/response schemas in
  `backend/src/app/http/openapi/schemas/agentSchemas.ts` gain the optional `binding`
  object; OpenAPI outputs regenerated; SDK types via `typescript-sdk` sync.
- No new endpoints; no status-code changes. Validation failure = existing 400 shape
  with descriptive message.
