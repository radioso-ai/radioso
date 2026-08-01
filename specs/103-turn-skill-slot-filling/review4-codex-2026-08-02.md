# Fourth-pass review: 103 Turn Skill Slot Filling

## Verdict

**REJECT.**

The routine/parked-input blocker is resolved by an explicit scope reduction, but two
contract decisions still prevent a determinate implementation.

1. **D9 / FR-018 do not define a deterministic scalar-normalization contract.**
   The type names and ISO output format are not enough. The spec does not say whether
   extracted JSON values must already have their native type or which string forms may
   be coerced; how `integer` differs at the boundary; the type of permitted values and
   how a typed canonical value compares to one; or whether a string field preserves or
   trims its value. More seriously, D9 says that a phrase such as "next Friday" is the
   reason to retain `date`, but conversion to `YYYY-MM-DD` needs an explicit reference
   instant and time zone. `TurnContext` supplies neither. ISO validation can verify a
   proposed date; it cannot deterministically decide which calendar date a relative
   expression denotes. This is a **spec-level gap**, not planning detail.

2. **FR-019 still omits the actual default and its unit.**
   It gives the resolver factory ownership of a configurable history limit, which is
   right, but says only that the default must be documented. It never chooses a number
   of messages and/or a token/character budget. The current engine loads unbounded
   history; its unrelated `12` constant limits trace references only. The default is a
   material privacy, cost, and recovery-behaviour decision and must be specified. This
   is a **spec-level gap**.

3. **D6 remains an unresolved ownership/dependency decision.**
   The only current scalar verifier is `conversation-engine/src/slotCorrection.ts`; it
   is routine-specific and lacks integer and permitted-value semantics. D6 requires
   reuse, while FR-005 puts the new default resolver in `conversation-defaults`.
   `conversation-defaults` already depends on `conversation-engine`, so making the
   engine consume a defaults-owned shared primitive would make the dependency cycle
   worse; reusing the present verifier cannot meet D9 either. The spec must choose the
   owner of a new pure normalizer and the migration boundary (or explicitly permit the
   resolver to own it for this slice). This is a **spec-level gap**.

## D8 trace

D8 is a legitimate scope reduction, not a durable-resumption design. With no persisted
claim, `awaitingSkillInput` cannot conflict with a routine's `awaitingDecision`:
`attemptRoutine()` runs first and returns a routine result only when the routine claims
the turn; a yielded routine returns `null`, after which normal selection can run. A
normal-path skill-input report and a routine decision therefore cannot coexist in one
engine result.

US2 scenario 4 works only conditionally, exactly as its “when the directive matches
again” clause says. On the answer turn, `attemptRoutine()` must yield or find no routine;
then `prepareTurn()` loads prior messages, matches directives before selection, and the
default selector selects the directive-bound skill. The planned resolver would receive
the bounded history plus the current input, so it can extract `Tuesday` and dispatch.
An `always` directive makes that path reliable.

For a contextual directive, `Tuesday` is **not guaranteed** to re-match. The default
probabilistic matcher is invoked before the resolver and asks the model whether the
condition holds; it is given the full history and latest message, so it may infer the
answer's context, but neither the matcher contract nor the prompt guarantees it. If an
active routine claims the turn, selection is skipped altogether. D8 acknowledges this
limitation, so the conditional acceptance scenario is achievable (for example with an
`always` directive), but this is not a general “ask, then accept any answer next turn”
flow. The spec must not describe retry as natural or reliable beyond that condition.

## D9–D11 and FR-018/FR-019

- **D9:** Unsound as written for the missing coercion/choice rules and relative-date
  reference described above.
- **D10:** Sound. Dropping the raw `conversation-tools` passthrough is the explicit,
  behavior-preserving producer migration that FR-002 previously lacked.
- **D11:** Sound. It supplies the previously missing disposition: fail closed, dispatch
  nothing, ordinary compose, and trace the failure. Exact failure-stage naming is a
  normal planning-phase detail.
- **FR-018:** Unsound until D9 defines the actual canonicalization and validation rules.
- **FR-019:** Its ownership decision is sound, but it is incomplete until the default
  bound and unit are named.

## Implementability

Not yet. The three items in the verdict are the remaining **spec-level** decisions. Once
they are settled, the remaining work—resolver/result type names, prompt layout, trace
stage identifiers, and focused tests—is normal planning-phase detail.

Confirmed: PR #966 is merged in this tree. `createDirectiveBoundSkillSelector` exists in
`packages/conversation-defaults/src/directiveBoundSkillSelector.ts`, is the kit default
through `createDefaultConversationSkillSelector`, and the routine dispatcher is wired in
`packages/conversation-kit/src/composition.ts`.
