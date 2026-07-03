# Research: Directive Skill Binding

No NEEDS CLARIFICATION markers remained in the approved spec. Decisions and their
rationale, consolidated from the design discussion and Codex spec review:

## Decision: Binding stored as discriminated JSONB target

- **Decision**: `agent_directives.binding JSONB NULL` holding
  `{"kind": "skill", "skillName": "<name>"}`; contract type
  `Directive.binding?: { kind: "skill"; skillName: string }`.
- **Rationale**: The requestor explicitly wants routine-targeted bindings later; a
  discriminated object makes that a validation/runtime change, not a data migration.
  JSONB avoids a second column per future kind.
- **Alternatives considered**: flat `skill_name TEXT` column (rejected — needs migration
  for routine kind); separate binding table (rejected — 1:0..1 relationship, no fan-out).

## Decision: Binding resolution lives beside the selector, not in the strategy

- **Decision**: pure helper `directiveBindingResolution.ts` consumed by
  `ChatTurnSkillSelector.resolveSkill/select`.
- **Rationale**: Codex review caught that `TurnSelectionStrategy` only returns
  candidate/reason data; `resolveSkill()` is where a `TurnSkill` is actually chosen
  (`turnSkillSelector.ts:43-49`). Strategy stays path policy.
- **Alternatives considered**: strategy-owned routing (rejected — cannot route);
  engine-owned routing (rejected — engine ordering must not change).

## Decision: Deterministic conflict ordering

- **Decision**: priority desc (null → 50, matching `authoredDirectiveMapper.ts`
  default), then `selectionConfidence` desc with deterministic (`always`) matches
  ranked as certain (1.0), then directive name asc.
- **Rationale**: FR-004 requires a single deterministic winner across export/import;
  directive names are unique per agent and portable, unlike ids or creation order.

## Decision: Authoring validation vs runtime availability

- **Decision**: create/update validates against the agent's `agent_skills` rows
  (exists + `enabled` + turn-capable invocation mode); runtime independently maps
  `skillName` → registered `TurnSkill.definition.name` and falls through when absent.
  Import bypasses authoring validation.
- **Rationale**: authoring-time guardrail catches typos; runtime must tolerate drift
  (skill disabled later, import into skill-less agent) per FR-005/FR-009.

## Decision: No matcher, engine, or steering-render changes

- **Decision**: matcher continues to see only name + condition; engine loop untouched;
  steering block rendering untouched.
- **Rationale**: spec anti-goals; `DirectiveMatch` already carries the full `Directive`
  (contract `index.d.ts:109-114`), so the binding reaches selection with zero plumbing.
