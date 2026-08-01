# Data Model: Skill Slot Filling

These are TypeScript contract entities, not persistent records. The engine does
not save an awaiting request.

## Skill input declaration

| Field | Type | Rules |
|---|---|---|
| `fields` | list of `SkillInputField` | Declared input allowlist for one skill; omitted/empty means no slot filling. |
| `name` | string | Unique within a skill declaration; only declared names can reach a handler. |
| `type` | `string \| number \| integer \| boolean \| date` | Exactly the v1 scalar set. |
| `required` | boolean | An unsatisfied required field parks the skill. |
| `description` | optional string | Model/composer-facing explanation; included in outstanding report when supplied. |
| `permittedValues` | optional string list | Allowed only for `string`; matching is trim + case-insensitive and returns declared spelling. |

`SkillDefinition.inputSchema` becomes this concrete declaration. `outputSchema`,
metadata, and transport-specific `ConversationToolDefinition.inputSchema` remain
separate.

## Resolver request and result

| Entity | Fields | Relationship / invariant |
|---|---|---|
| Resolver request | `skill`, `selected`, immutable `turn` | One request for every selected skill during phase one. |
| Ready resolution | canonical allowlisted input, safe field outcomes | Eligible for phase-two dispatch only. |
| Needs-input resolution | outstanding declared required field reports | Never dispatches; contributes one `awaitingSkillInput` entry. |
| Failed resolution | safe failure code and structural outcomes | Never dispatches and is not phrased as a missing-input ask. |
| Field outcome | field name, provenance category, `ready \| absent \| rejected`, optional safe reason | May be traced; never contains a value. |

### Value transitions

```text
declared field
  -> valid host value -> canonical ready (model never sees it)
  -> invalid host value -> rejected outstanding (never dispatched/replaced)
  -> absent host value -> extract once -> canonical ready | absent | rejected | resolution failed

all selected skills ready -> dispatch phase
any needs-input or failed -> zero dispatches
```

## Awaiting skill input result

`ProcessTurnResult.awaitingSkillInput` is an optional list. Each entry has a
`skillName` and its outstanding field reports (name, scalar type, description,
permitted values, reason `absent` or `rejected`). It describes only the current
turn, has no identifier/capture key/decision options, and is deliberately not
stored or resumed by the engine.

## Validation rules

| Scalar type | Accepted model value | Canonical value | Reject |
|---|---|---|---|
| `string` | JSON string | trimmed non-empty string | non-string or empty after trim |
| `number` | JSON number or finite-decimal JSON string | JS number | NaN, Infinity, unparseable |
| `integer` | accepted `number` that is integral | JS number | fractional value |
| `boolean` | JSON `true`/`false` | boolean | strings/numbers |
| `date` | `YYYY-MM-DD` JSON string | same string | relative/locale/other format |

Undeclared model keys are discarded. Invalid values are never passed to a
handler and are observable only structurally.

