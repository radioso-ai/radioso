# Data Model: Fused Turn Planning

This feature adds no persistent entities or database migrations. Its state is
ephemeral and scoped to one assistant turn.

## TurnPlan

- `route`: direct or retrieval
- `framing`: normalized routing context
- `rewriteProposal`: optional structured retrieval rewrite
- `responseLanguage`: optional normalized language label
- `routineRankings`: candidate routine identifiers with confidence and optional
  activation variables extracted from the turn
- `directiveClassifications`: candidate directive names with match/confidence

Validation rejects the complete plan when its structure is invalid or it names
a routine/directive outside the supplied candidate set.

## TurnPlanOutcome

- `planned`: valid plan plus the exact prepared routine candidate set
- `bypassed`: planner did not run, with a typed eligibility reason
- `failed`: planner ran but produced no usable plan

Every consumer observes the same memoized outcome.

## Prepared candidate bundles

Routine and directive owners expose bounded, policy-aware candidate summaries.
The planner may classify them but cannot mutate eligibility or resolve product
decisions.
