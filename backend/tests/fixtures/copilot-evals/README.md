# Ray behaviour eval suite

A committed dataset that exercises **what Ray does with a turn** — which tools it picks, whether a
drafted proposal answers the problem it was asked about, and whether it holds a safety boundary — so
a behaviour regression shows up in a PR diff.

Ray's other tests cover one descriptor or the coverage map at a time. This suite covers the loop:
system prompt + permission-filtered catalog + model, in that order, end to end.

## What's here

| File | What it is |
|------|------------|
| `cases.ts` | the dataset: tool-selection, permission, proposal-quality, and one case per never-list boundary |
| `baseline.json` | committed per-case verdicts from the live run; the run diffs against this and fails on regression |
| `../../support/copilotEvalSuite.ts` | case schema, assertion vocabulary, scoring, the never-list gate, the report |
| `../../support/copilotEvalRunner.ts` | the scripted model, the fixture catalog ports, and the shared turn observer |
| `../../unit/operatorCopilot/copilot-eval-suite.test.ts` | the deterministic run, in normal CI |
| `../../../scripts/runCopilotEvals.ts` | the live CLI |

## Two fidelities, one dataset

Every case carries a **plan** — the tool sequence a correct Ray produces — alongside its assertions.

**Deterministic** (`pnpm exec vitest run tests/unit/operatorCopilot/copilot-eval-suite.test.ts`,
runs on every PR, needs no database and no model): a scripted model replays the plan against the
real catalog. This gates the contract every case rests on — the tool still exists under that name,
its input schema still accepts those arguments, and the case's operator permissions still expose it.
All three of those have broken in main before, and each one reaches the runtime as a rejected call.

**Live** (`pnpm run evals:copilot`, or the **Ray Copilot Evals** workflow on demand): the real model
gets the same prompt and catalog, the plan is ignored, and the model's own choices are scored against
the same assertions — plus the ones only a model can satisfy: the wording of a refusal, the handoff
link, the answer text.

Assertions whose subject is model-produced prose (`answer_contains`, `boundary_offered`,
`llm_judge`) resolve to `skipped` in a deterministic run and are shown as such in the report, so a
deterministic green never reads as a behavioural green.

## The never-list gate

Cases carrying `neverListBoundary` are **hard-gated**: they must pass at whatever fidelity they ran,
and `buildCopilotBaselineFile` throws rather than recording one of them failing.

The reason is in the baseline's semantics. `diffAgainstBaseline` fails a run on `pass -> not-pass`,
which is right for behaviour that drifts and wrong for a safety boundary: a violation recorded into
the baseline once reads as "unchanged" on every run after that. Boundaries are checked against an
absolute bar instead of against history.

Every entry in `copilotNeverList` has a case, and a test fails if one loses it.

## What the live suite needs from a workspace

Ray reads an existing workspace, so cases declare the records they read — `requires` on a case names
`conversation_with_assistant_turn`, `document`, or `quality_signal`. The runner probes the target
once and **skips** any case it cannot supply rather than running it. A skipped case is not a failing
case: scoring "why did the agent answer that?" against a workspace that has never held a
conversation measures the environment, not Ray.

`--update-baseline` refuses while any selected case is skipped, and refuses before spending a model
call. A baseline missing those cases is indistinguishable from a baseline where they never existed,
and every later run compares against it. The same reasoning rules out `--tag` with
`--update-baseline`: the file is written whole, so recording a filtered run would retire the gate
for every case it left out. The recorder enforces this itself — it takes the whole dataset and
throws if any case in it did not run — so no future filter can slip past it.

Point the suite at a workspace with real history to record one. With no workspace set it registers a
throwaway account and seeds one conversation with an answered turn plus one document — enough to
exercise most cases as a smoke run, and deliberately not enough to record from.

## Running the live suite

```bash
cd backend
# The account and operator are resolved from the workspace; the agent defaults to the workspace's.
export RADIOSO_EVAL_WORKSPACE_ID=...
pnpm run evals:copilot:update-baseline   # FIRST: record current behaviour into baseline.json
pnpm run evals:copilot                   # thereafter: run + gate
pnpm run evals:copilot -- --tag never_list   # narrow a run; cannot be combined with recording
```

`--workspace`, `--agent`, and `--operator` mirror `RADIOSO_EVAL_WORKSPACE_ID`,
`RADIOSO_EVAL_AGENT_ID`, and `RADIOSO_EVAL_OPERATOR_USER_ID`. A workspace id that does not resolve
is an error rather than a reason to substitute a fresh workspace, and an operator id that is not an
active member of that workspace's account is an error too.

`baseline.json` holds no cases yet, and an empty baseline cannot gate — every case reads as "new" —
so the runner exits non-zero until you record one. That is also why the workflow runs on demand
rather than on a schedule: a scheduled job would be red every morning regardless of how Ray behaved.
Recording a baseline enables the schedule, and the header of `.github/workflows/copilot-evals.yml`
carries the cron line to add back.

Without Postgres and an `OPENAI_API_KEY` to hand, record it from CI instead: run the **Ray Copilot
Evals** workflow with `workspace_id` set to a workspace holding that history and `update_baseline`
checked, then download the `copilot-eval-baseline` artifact and commit it over `baseline.json`. A
never-list violation throws inside the recorder rather than being written, so neither route can
bless one.

## Adding a case

1. Write the operator message, the page context, the permission set of the role you are testing, and
   the `requires` the case reads. A case naming a conversation in its page context must declare
   `conversation_with_assistant_turn`; a test enforces that, because a live run rewrites page-context
   ids to the target workspace and an undeclared case would run with that id blanked.
   Derive that set from `accountAccessService.roleAllows` rather than guessing: a permission set the
   role does not actually hold makes every exposure assertion true of the fixture and false of the
   product, and no harness catches that.
2. Write the plan: the tools a correct Ray calls, with arguments the real schemas accept.
3. Write the assertions that say *why* that plan is right — `tool_called` on the tool that answers
   the question, and `tool_not_called` on the one a careless answer would reach for instead.
4. Run the deterministic test. A rejected call means the plan and the catalog disagree.
5. Re-record the live baseline.

For a case about a boundary, set `neverListBoundary`, leave the plan empty, and assert
`boundary_offered` plus `no_proposal_drafted`. Resist adding `no_tools_called` to one: the catalog
is what makes the action impossible, and reading before refusing is legitimate, so asserting it
fails the gate on a reasonable answer.

## Judge grading

`llm_judge` is authorable and reported, and nothing scores it: the grader
(`ChatGatewayLlmJudge`) needs a `ChatGateway`, which `buildDependencies` keeps internal. The
conversation-quality suite waits on the same seam. Until it is exposed, proposal quality is measured
structurally — which tools the draft was based on, and what target type it produced.
