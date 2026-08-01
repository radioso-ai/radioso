# Third-pass review: 103 Turn Skill Slot Filling

## 1. Verdict

**REJECT.**

Blocking items:

1. **A parked selected-skill input request has no defined precedence against routines.**
   `processTurn` calls `attemptRoutine` before the normal selection path. An active routine
   may yield a turn, which permits normal skill selection; this feature can then park that
   selected skill. On the visitor's next answer, the still-active routine resumes first and
   selection/filling is skipped. Likewise, an idle routine activator can claim that answer
   before the selected skill is reconsidered. The requested value can therefore never reach
   the parked skill. Define whether a pending skill request is durable and takes precedence,
   whether yielded-routine turns cannot park selected skills, or another explicit precedence
   rule. Also state that `awaitingSkillInput` and routine `awaitingDecision` are mutually
   exclusive on one result.

2. **FR-004 cannot represent the multi-selection behavior required by FR-006 and FR-011.**
   It names one skill and its fields, while more than one selected skill can need input and
   the reply must cover *all* missing fields. Define a per-skill request array (including
   per-field reason codes), or explicitly constrain this feature to a single selected skill.
   The current kit still supports multiple explicit `selectedSkills`.

3. **The field-declaration and normalization contract is not defined enough to implement.**
   “Scalar type” has no closed enum or canonical forms. Specify the supported types, the
   accepted input representations, coercion and permitted-value comparison rules, and in
   particular the canonical date format. “No locale-ambiguous date interpretation” is not a
   substitute for defining what a `calendar_date` accepts.

4. **FR-002 leaves an incompatible producer migration as an implementer choice.**
   The current `conversation-tools` bridge copies MCP/OpenAPI raw JSON schemas into
   `SkillDefinition.inputSchema`; automatic projection is explicitly cut. Choose the
   replacement behavior: for example, retain raw schemas only on `ConversationToolDefinition`
   and omit `inputSchema` when creating `SkillDefinition`, or define a supported deliberate
   projection. “Either” leaves a public compatibility decision unresolved.

5. **The resolver's `failed` path has no result/compose contract.**
   FR-003 defines `ready | needs-input | failed`, and FR-012 says parse/model/deadline
   failures fail closed, but does not say whether failure becomes a failed `TurnOutcome`, an
   `awaitingSkillInput` with a retryable reason, or a distinct rendered/degraded result. The
   engine and composer need one defined shape, including what is traced without values.

6. **“Bounded history” lacks its bound and ownership.**
   `ConversationStores.loadHistory` currently loads without a limit; the engine's `12`-item
   constant limits trace references only. Define the extraction history window/token bound
   and whether it is resolver configuration or an engine-owned limit.

## 2. D1–D7 fidelity to the second review

| Decision | Faithful? | Review |
| --- | --- | --- |
| D1 | Yes | This is the two-phase, immutable pre-dispatch resolution plan I recommended. |
| D2 | Yes | It correctly gives skill input its own result shape rather than reusing routine decisions or clarification. |
| D3 | Yes | One extraction call plus ordinary composition with synthetic steering is the recommended model. |
| D4 | Yes | Bounded history plus the current message, excluding staged context, metadata, and host values, matches the recommendation. The numeric bound still needs specification. |
| D5 | Yes | “Authoritative on provenance, not validity” is the requested host-input rule. |
| D6 | No, not fully | I recommended reusing/extracting the normalization *semantics*, not assuming an existing reusable primitive. The existing verifier is routine-specific and lives in the engine. I explicitly left open a new resolver owning the primitive with a later routine migration. D6 settles that open choice as mandatory sharing without acknowledging the change. |
| D7 | Yes | It accurately narrows timeout to bounding the turn wait; the current model gateway cannot cancel the provider call. |

## 3. D1's same-turn consequence

It is acceptable for this feature and does **not** break an existing slot-filling behavior:
there is no selected-skill resolver today. The engine does currently dispatch selected skills
sequentially: skill B receives skill A's staged context and outcome guidance. That behavior
must remain for dispatch itself. D1 only prevents the *new* pre-dispatch resolver from reading
A's not-yet-produced output, which is necessary to ensure no skill side-effects before every
selection is known ready. The kit default selector normally chooses one directive-bound winner;
hosts can still explicitly select multiple skills, so the two-phase plan must preserve their
existing sequential dispatch visibility after resolution succeeds.

## 4. Scope checks

Nothing in “Minimum that cannot be cut” is genuinely cuttable. In particular, the
`conversation-tools` migration is mandatory because its current bridge writes raw transport
schemas into the field that FR-001 changes.

The listed cuts are appropriate:

- Untyped routine-step filling is correctly deferred; routine skill steps have their own
  `inputBindings` contract.
- Author-controlled sourcing, nested values, arrays, backend adoption, and cross-skill
  filling can remain out of scope.
- Automatic MCP/OpenAPI projection can remain cut **only after** FR-002 chooses the
  non-projection migration behavior.
- Locale-ambiguous dates can remain cut, but the supported unambiguous date representation
  is required, not cuttable.

## 5. New third-draft risk: routine interaction

The new `awaitingSkillInput` result and all-resolve-before-dispatch rule expose an unaddressed
routine state-machine conflict. Routine results already contain outcomes and can contain
`awaitingDecision`, but a routine that claims a turn short-circuits normal selection entirely;
there is no same-turn dual state. A routine `skill` step also does not use the normal selected
skill dispatcher, so FR-016 is otherwise sound.

The failure is across turns: a yielded active routine can let a selected skill park, then
resume-first routing steals the answer. A fresh routine activation can do the same to a parked
request from an otherwise idle turn. This is new to the third draft's parked-result design and
needs the precedence/persistence decision in blocking item 1. `awaitingDecision` and
`awaitingSkillInput` should be modeled as exclusive current-turn states unless a future design
introduces an explicit compound state.

## 6. Implementability

No. The engineer still needs decisions on:

1. parked-skill-input precedence/persistence versus active, yielded, and newly activating
   routines, plus exclusivity with `awaitingDecision`;
2. one versus many pending skill requests and the exact `AwaitingSkillInput` shape, including
   reason-code placement;
3. supported scalar types, canonical values, coercion, choice matching, and date format;
4. the exact `conversation-tools` raw-schema migration;
5. the observable `failed` resolver result and composer/trace behavior; and
6. the bounded-history limit and its configuration owner.

## Verification of the rebase note

Confirmed. `packages/conversation-defaults/src/directiveBoundSkillSelector.ts` now exports
`createDirectiveBoundSkillSelector`, and
`packages/conversation-kit/src/defaultPorts.ts` makes it the default selector whenever explicit
turn metadata has not selected a skill. The second review's selector-existence objection was a
branch artifact and is withdrawn.
