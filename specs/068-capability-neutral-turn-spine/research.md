# Research & Design Notes: Capability-Neutral Turn Spine

This note records why `068` is shaped the way it is, the Parlant validation behind it, and a worked design of the keystone seam (the generic turn outcome + renderer registry) against the current chat turn.

## The problem 066 left

066 made retrieval a *dispatched* skill and removed `RetrievalPipelineService` from `ChatService` (SC-002). But the turn is still **not capability-neutral**:

- `ChatService.answer`/`streamAnswer` branch: `handleSkillIntake(...)` → if a skill's intake matched, complete the intake turn; **else** run the grounded-answer path. Two parallel code paths, not one loop.
- The grounded compose (`composeGroundedSystemPrompt`, the envelope/citation/suggestion/grounded-miss machinery) is typed to `session.retrieval: RetrievalPipelineResult`.

So a capability that is neither "an intake skill" nor "retrieval" has no first-class route, and the compose step can't render a generic skill outcome. That is the gap SC-001 / User Story 1 names, and it is what blocks 067 slices 3–4.

## Why the fix is "generalize", not "replace (b)"

Verified against Parlant (`~/code/parlant`). Its `engines/alpha/prompt_builder.py` builds message generation from **one** unified context — `add_staged_tool_events` (tool *results*), `add_guidelines_for_message_generation` (matched condition→action rules), `add_context_variables`, `add_glossary`, `add_interaction_history`. There is no tool-specific or retrieval-specific composer; a single generator renders from all of it, and tools contribute staged **data**, not pre-composed answers.

That is exactly Radioso's **resolution (b)** (capabilities stage context; the loop composes) plus a **generic** staged context. So (b) was right. What makes our turn retrieval-shaped is not (b) — it is that the staged context is *typed* to `RetrievalPipelineResult`. The fix is to generalize that context and route rendering by outcome kind, keeping (b).

## The keystone seam: turn outcome + renderer registry

Today the turn's "what happened" is implicitly one of two things: a `ChatIntakeResult` (skill path) or a `RetrievalPipelineResult` on `session.retrieval` (grounded path). `068` unifies these into one generic value the composer reads:

```ts
// chat-owned: the generic result of a turn's dispatched capability/ies
interface TurnOutcome {
  skillName: string;                 // what was dispatched (retrieval.answer, order.status, …)
  outcome: SkillOutcome;             // the control envelope (066): status, answer?, outputs?, guidance?, metadata?
  steering: SteeringRule[];          // directives (067) + skill-emitted guidance, merged
}
```

Rendering is dispatched by outcome *kind/capability*, not by skill name:

```ts
interface TurnOutcomeRenderer {
  // can this renderer handle the outcome? (e.g. "the outcome carries a retrieval result")
  supports(outcome: TurnOutcome): boolean;
  render(outcome: TurnOutcome, ctx: ComposeContext): Promise<ChatPresentedAnswer>;
}
```

- The **retrieval renderer** `supports` an outcome whose `metadata` carries a `RetrievalPipelineResult` (via the existing `readRetrievalResult`) and renders it through **today's** grounded composition — citations, suggestions, grounded-miss, streaming, eval-snapshot fields — unchanged. This is **extraction, not rewrite** (slice 1).
- The **generic renderer** renders `outcome.answer`/`outputs` through the LLM/canned path for any other skill (slice 2).

The loop holds an ordered list of renderers (retrieval first, generic last) resolved at composition, and picks the first that `supports` the outcome. No `if (skillName === …)` anywhere in the loop or the generic renderer (SC-003).

## The selection seam

Today selection is the hard-coded `handleSkillIntake ? intake : (retrievalEnabled ? grounded : direct)`. `068` lifts it to a per-agent strategy:

```ts
interface TurnSelectionStrategy {
  select(input: { gathered: GatheredTurnContext; directives: DirectiveMatch[] }): Promise<SelectedSkill[]>;
}
```

The v1 default strategy reproduces today's behavior (intake-intent match → that skill; else retrieval.answer if enabled; else direct), so it is parity-preserving. 067 slice 4 makes the strategy read `directives` as soft signals; the structured decision stays authoritative, and selection is never an English keyword list (FR-009).

## Parity is the hard constraint

The grounded path is the richest and most-tested behavior (citations, streaming, grounded-miss, eval snapshots in `chatTurnLifecycle`). The retrieval renderer must reproduce it byte-for-byte. Therefore slice 1 is an **extraction**: move the existing `composeGroundedSystemPrompt` + envelope/citation flow behind the retrieval renderer with no behavior change, guarded by the existing `chat-service-streaming` suite. Only after that does the generic renderer (slice 2) and the strategy (slice 3) arrive.

## Decisions captured

- **Keep resolution (b).** Capabilities stage data; the loop composes. Parlant-validated.
- **Generalize the staged context**, do not move composition into skills. The retrieval result rides on the `SkillOutcome` (as 066 already does via `metadata`).
- **Render by outcome kind via a registry**, never by skill-name branches. Retrieval renderer = extraction of today's grounded compose.
- **Selection is a per-agent strategy**, not loop branches; Directives bias it as soft signals (067 slice 4).
- **No new persistence**; the turn outcome is per-turn, the event stream stays the source of truth.

## Relationship to other specs

- Depends on `066` (merged: retrieval dispatched as a skill, `RetrievalTurnPort`) and `067` slices 1–2/5 (directives + the `SteeringRule` set).
- Unblocks `067` slices 3–4 (guidance convergence + selection biasing), which land on slice 4 here.
- Still unbuilt vs. Parlant after this (deferred): Glossary, Context Variables, canned/strict output mode, Journeys (our "Routine"), and the richer relationship kinds (`DEPENDENCY_ANY`, `ENTAILMENT`, `DISAMBIGUATION`, `REEVALUATION`).
