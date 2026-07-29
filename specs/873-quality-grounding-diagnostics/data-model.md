# Data Model: Quality Grounding Diagnostics

## Grounding Diagnostic

An immutable snapshot attached to one assistant `messages` row.

| Database field | Public field | Type | Rule |
|---|---|---|---|
| `grounding_verdict` | `verdict` | nullable text | `grounded`, `degraded`, or `no_support` |
| `grounding_claim_count` | `claimCount` | nullable integer | non-negative |
| `grounding_sourced_claim_count` | `sourcedClaimCount` | nullable integer | non-negative |
| `grounding_unsourced_claim_count` | `unsourcedClaimCount` | nullable integer | non-negative |
| `grounding_invalid_source_count` | `invalidSourceCount` | nullable integer | non-negative |

### Invariants

- All five fields are null, or all five are present.
- `sourcedClaimCount + unsourcedClaimCount = claimCount`.
- Zero is meaningful and distinct from null.
- The snapshot is written with the answer and never recomputed after document,
  setting, or agent changes.
- Quality exposes a complete camel-case object or `null`.

## Quality Turn

The existing `LowQualityTurn` gains:

```ts
grounding: {
  verdict: "grounded" | "degraded" | "no_support";
  claimCount: number;
  sourcedClaimCount: number;
  unsourcedClaimCount: number;
  invalidSourceCount: number;
} | null;
```

No Quality stats entity changes. Existing signal classification continues to use
skill-catalog outcome metadata.

## Grounding Filters

| Filter | Type | Match |
|---|---|---|
| `groundingVerdict` | zero or more verdicts | any selected verdict |
| `hasUnsourcedClaims=true` | boolean | complete diagnostic, unsourced count > 0 |
| `hasUnsourcedClaims=false` | boolean | complete diagnostic, unsourced count = 0 |
| `hasInvalidSources=true` | boolean | complete diagnostic, invalid count > 0 |
| `hasInvalidSources=false` | boolean | complete diagnostic, invalid count = 0 |

Filter families are ANDed with each other and existing Quality filters. Null
diagnostics match neither boolean value.

## Historical State Transition

```text
all columns null
  ├─ newest eligible event complete + valid ─> complete snapshot
  └─ missing/partial/malformed/inconsistent ─> all columns null

complete snapshot ─> unchanged on migration retry
```

The eligible set is exactly `chat.answer` and `chat.suspended`. The newest event
is chosen before validation using creation time and identifier descending.
