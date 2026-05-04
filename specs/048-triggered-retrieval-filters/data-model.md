# Data Model: Triggered Retrieval Filters

## Triggerable Retrieval Rule

- Base entity: existing retrieval metadata rule persisted inside retrieval settings.
- New additive fields:
  - `triggerInstruction?: string`
  - `triggerMode: "always_on" | "match_turn"`
  - `triggerMetadata?: { lastEditedAt?: string }`
- Existing fields retained:
  - `id`
  - `field`
  - `valueType`
  - `operator`
  - `value`
  - `effect`
  - `enabled`
- Validation rules:
  - `triggerInstruction` is optional and trimmed.
  - Empty `triggerInstruction` normalizes to unset and implies `triggerMode = "always_on"`.
  - Triggerable rules remain additive-compatible with existing saved rules that have no trigger fields.
  - Hard-filter semantics remain explicit through the existing `effect = "filter"` field.

## Dynamic Metadata Value

- Purpose: represent bounded execution-time date semantics instead of opaque saved literals.
- Shape:
  - `kind: "literal" | "today"`
  - `raw: string`
- Supported contexts:
  - only `valueType = "date"`
  - only comparison operators already supported for dates: `equals`, `not_equals`, `lt`, `lte`, `gt`, `gte`
- Validation rules:
  - `today()` is the only approved dynamic token in this feature.
  - unsupported operator/value-type combinations fail validation or execution safely with explicit diagnostics.

## Trigger Match Candidate

- Derived from enabled retrieval rules with a non-empty `triggerInstruction`.
- Fields:
  - `ruleId`
  - `triggerInstruction`
  - `effect`
  - `field`
  - `operator`
  - `value`
  - `valueType`
- Constraints:
  - only enabled rules participate.
  - rules without trigger instructions are treated as always-on and excluded from the matcher candidate list.

## Trigger Match Decision

- Produced during query interpretation.
- Fields:
  - `status: "skipped_not_configured" | "skipped_unavailable" | "applied" | "fallback"`
  - `consideredRules: TriggerDecisionEntry[]`
  - `matchedRuleIds: string[]`
  - `unmatchedRuleIds: string[]`
  - `matchCount: number`
  - `matcherVersion: string`
  - `failureReason?: string`
- `TriggerDecisionEntry` fields:
  - `ruleId`
  - `matched: boolean`
  - `matchStrength: number`
  - `reason: string`
  - `triggerInstructionPreview: string`
- Constraints:
  - supports zero, one, or many matches.
  - reasons are bounded and human-readable.
  - diagnostics keep bounded previews, not raw full prompts or chain-of-thought.

## Active Retrieval Rule Set

- Derived in candidate preparation from workspace rules plus trigger decisions.
- Fields:
  - `alwaysOnRules: TriggerableRetrievalRule[]`
  - `triggerMatchedRules: TriggerableRetrievalRule[]`
  - `inactiveTriggeredRules: TriggerableRetrievalRule[]`
  - `enactedRules: TriggerableRetrievalRule[]`
- Constraints:
  - always-on rules remain active regardless of trigger matching.
  - trigger-based rules activate only when matched.
  - inactive triggered rules remain visible in diagnostics.

## Policy Backoff Decision

- Derived in candidate preparation when trigger-enacted narrowing is relaxed.
- Fields:
  - `applied: boolean`
  - `reason?: "empty_filtered_candidates" | "weak_filtered_support"`
  - `relaxedRuleIds: string[]`
  - `restoredCandidateCount?: number`
- Constraints:
  - only applies when trigger-matched destructive narrowing reduced support below the accepted threshold.
  - must be propagated to retrieval info, trace, and history debug metadata.

## Trigger Analysis Trace Node

- Logical trace/history presentation entity.
- Fields:
  - `stageId = "trigger_analysis"`
  - `status`
  - `inputs.query`
  - `outputs.consideredRules`
  - `outputs.matchedRuleIds`
  - `outputs.unmatchedRuleIds`
  - `outputs.backoffDecision?`
  - `metrics.matchCount`
  - `metrics.consideredRuleCount`
  - `reason?`
- Constraints:
  - appears independently in trace even though execution lives inside query interpretation.
  - explicit skipped state is required when no triggerable rules exist.
