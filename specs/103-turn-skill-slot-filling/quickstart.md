# Quickstart: Verify Skill Slot Filling

Implementation follows this sequence; each test is written failing before its
production code.

1. Define a kit skill whose declaration has required `calendar_date: date` and
   optional `haircut_style: string` with permitted values. Bind it to an `always`
   directive and use a fake model gateway returning the declared JSON fields.
   Run one turn and verify the local handler receives only canonical values.
2. Run a turn supplying only the required value. Verify the optional property is
   absent. Seed an earlier user event, select the skill later, and verify bounded
   history allows recovery.
3. Omit a required value. Verify the handler is not called, one normal composed
   reply asks for all missing fields and choices, and the result has one
   `awaitingSkillInput` entry with `absent` reasons. In the engine stream test,
   drain events and verify the final event contains that same result.
4. Supply invalid choice/type output. Verify it never reaches the handler, the
   field is reported `rejected`, trace JSON contains the name/reason but not the
   fake value, and a later answer turn under an `always` directive fills it.
5. Give a selector complete valid `SelectedSkill.input`. Verify it is normalized,
   dispatched, and no extraction model call occurs. Give it invalid host input
   and verify it parks/fails closed rather than dispatching or replacing it.
6. Select two declared skills; make one resolver result needs-input or failed.
   Verify neither handler runs. Make both ready and verify the existing second
   dispatcher call still sees first-outcome staged context/guidance, while both
   resolver calls saw only the immutable pre-dispatch snapshot.
7. Select a no-fields skill. Verify no resolver/model call and unchanged handler
   input/dispatch behaviour. Verify routine skill tests retain authored
   `inputBindings` semantics.
8. Map an MCP/OpenAPI-style tool with raw `inputSchema`. Verify its transport
   definition retains that raw data but the emitted `SkillDefinition` omits it.

Run focused Vitest suites during implementation. Do not run package builds in
this environment. If static verification is required, use only:

```bash
pnpm exec tsc --noEmit -p packages/conversation-contract/tsconfig.json
pnpm exec tsc --noEmit -p packages/conversation-engine/tsconfig.json
pnpm exec tsc --noEmit -p packages/conversation-defaults/tsconfig.json
pnpm exec tsc --noEmit -p packages/conversation-kit/tsconfig.json
pnpm exec tsc --noEmit -p packages/conversation-tools/tsconfig.json
```

The final documentation check confirms the kit README describes field
declarations, `awaitingSkillInput`, no handler dispatch while parked, and the
host-forced retry path when contextual directive re-matching is not guaranteed.

