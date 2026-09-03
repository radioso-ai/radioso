/**
 * Headless runner for the committed Ray behaviour suite (issue #1054).
 *
 *   pnpm run evals:copilot                      # real model, diff against the baseline
 *   pnpm run evals:copilot -- --samples 3       # run each case 3x and reduce (what the CI script does)
 *   pnpm run evals:copilot -- --update-baseline # re-record baseline.json after an intended change
 *   pnpm run evals:copilot -- --tag never_list  # only cases carrying a tag (repeatable)
 *   pnpm run evals:copilot -- --case boundary-pending-decision --samples 8   # one case, many samples
 *
 * Ray's live behaviour is nondeterministic, so one run is one SAMPLE of it. A baseline recorded from
 * a single run freezes each case at whichever way it happened to fall, and then reports the other
 * outcome as a regression on unchanged code (issue #1152). Record and compare with `--samples`.
 *
 * It assembles the real application stack (buildDependencies) and drives each case through the
 * composed copilot catalog, prompt, and capability runner — the same three the dashboard turn uses.
 *
 * REQUIREMENTS (this is a live path, not a unit test):
 *   - DATABASE_URL to a Postgres with pgvector, migrated.
 *   - Provider credentials (LLM_PROVIDER + OPENAI_API_KEY / equivalent). The point is a real model.
 *   - A target workspace. Set RADIOSO_EVAL_WORKSPACE_ID (--workspace) to point at one; the account
 *     and operator are resolved from it, and RADIOSO_EVAL_AGENT_ID (--agent) is optional because the
 *     workspace's default agent is used otherwise. With none set, a throwaway account is registered
 *     and seeded with the minimum history the cases read.
 *
 * Ray reads an existing workspace, so cases carry the records they need. A case whose records the
 * target cannot supply is skipped rather than run: scoring it against an empty workspace would
 * record an environment gap as Ray's behaviour, and --update-baseline refuses while any case is
 * skipped so a partial baseline can never become the thing later runs compare against.
 *
 * The deterministic half of this suite runs in normal CI via
 * tests/unit/operatorCopilot/copilot-eval-suite.test.ts; it needs neither a database nor a model.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv } from "../src/app/config/env.js";
import { buildDependencies } from "../src/app/server/dependencies.js";
import { runMigrations } from "../src/db/runMigrations.js";
import { AnswerFeedbackService } from "../src/modules/chat/composition.js";
import { createLogger } from "../src/shared/observability/logger.js";
import { diffAgainstBaseline, isBaselineInitialized, type BaselineFile } from "../src/modules/eval/suite/index.js";
import {
  buildCopilotBaselineFile,
  copilotHandoffGaps,
  copilotHardGateViolations,
  formatCopilotEvalReport,
  parseCopilotEvalCases,
  runCopilotEvalSuite,
  selectRunnableCopilotEvalCases,
  type CopilotEvalCase,
  type CopilotEvalWorkspaceRequirement,
} from "../tests/support/copilotEvalSuite.js";
import { COPILOT_EVAL_ROUTINE_NAME, observeCopilotTurn } from "../tests/support/copilotEvalRunner.js";
import { copilotEvalCases } from "../tests/fixtures/copilot-evals/cases.js";

const BASELINE_PATH = fileURLToPath(new URL("../tests/fixtures/copilot-evals/baseline.json", import.meta.url));

interface Flags {
  updateBaseline: boolean;
  samples: number;
  passThreshold: number;
  tags: string[];
  caseIds: string[];
  workspaceId: string;
  agentId: string;
  operatorUserId: string;
  migrate: boolean;
  keepWorkspace: boolean;
}

const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = {
    updateBaseline: false,
    samples: 1,
    passThreshold: 1,
    tags: [],
    caseIds: [],
    workspaceId: process.env.RADIOSO_EVAL_WORKSPACE_ID ?? "",
    agentId: process.env.RADIOSO_EVAL_AGENT_ID ?? "",
    operatorUserId: process.env.RADIOSO_EVAL_OPERATOR_USER_ID ?? "",
    migrate: false,
    keepWorkspace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--update-baseline") flags.updateBaseline = true;
    else if (arg === "--samples") flags.samples = Math.max(1, Number.parseInt(argv[++index] ?? "1", 10) || 1);
    else if (arg === "--pass-threshold") flags.passThreshold = Math.min(1, Math.max(0, Number.parseFloat(argv[++index] ?? "1") || 1));
    else if (arg === "--keep-workspace") flags.keepWorkspace = true;
    else if (arg === "--migrate") flags.migrate = true;
    else if (arg === "--tag") flags.tags.push(argv[++index] ?? "");
    else if (arg === "--case") flags.caseIds.push(argv[++index] ?? "");
    else if (arg === "--workspace") flags.workspaceId = argv[++index] ?? "";
    else if (arg === "--agent") flags.agentId = argv[++index] ?? "";
    else if (arg === "--operator") flags.operatorUserId = argv[++index] ?? "";
  }
  return flags;
};

const loadBaseline = (): BaselineFile => {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Partial<BaselineFile>;
    return { generatedAt: parsed.generatedAt, cases: parsed.cases ?? {} };
  } catch {
    return { cases: {} };
  }
};

type Deps = ReturnType<typeof buildDependencies>;

/**
 * Narrows the dataset to what this run is about. Both filters exist so iterating on one behaviour
 * costs one case rather than the suite — a live sample is a model call, and stabilising a single
 * flaky case needs many samples of that case, not one of everything.
 */
const narrowDataset = (cases: CopilotEvalCase[], flags: Pick<Flags, "tags" | "caseIds">): CopilotEvalCase[] => {
  const byTag = flags.tags.length === 0 ? cases : cases.filter((entry) => (entry.tags ?? []).some((tag) => flags.tags.includes(tag)));
  return flags.caseIds.length === 0 ? byTag : byTag.filter((entry) => flags.caseIds.includes(entry.id));
};

/**
 * Rewrites the fixture's placeholder ids to the live workspace's own. Cases name an agent and a
 * conversation so the model has something concrete to reason about; against a live stack those ids
 * have to exist or every tool call returns "not found" and the run measures nothing.
 */
const bindToLiveWorkspace = (
  cases: CopilotEvalCase[],
  live: { agentId: string; conversationId: string | null; routine: { id: string; name: string } | null },
): CopilotEvalCase[] =>
  cases.map((entry) => ({
    ...entry,
    pageContext: {
      ...entry.pageContext,
      agentId: entry.pageContext.agentId ? live.agentId : null,
      conversationId: entry.pageContext.conversationId ? live.conversationId : null,
    },
    // A case names its routine the way an operator does — by title, in the message — so binding
    // rewrites the name as well as the id. Ray resolves the name against the live workspace.
    ...(live.routine ? {
      message: entry.message.replaceAll(COPILOT_EVAL_ROUTINE_NAME, live.routine.name),
      plan: entry.plan.map((step) => bindRoutineId(step, live.routine!.id)),
    } : {}),
  }));

const bindRoutineId = (step: { tool: string; input: unknown }, routineId: string) =>
  step.input && typeof step.input === "object" && !Array.isArray(step.input) && "routineId" in step.input
    ? { ...step, input: { ...step.input as Record<string, unknown>, routineId } }
    : step;

interface EvalTarget {
  workspaceId: string;
  agentId: string;
  accountId: string;
  operatorUserId: string;
  /** True when this run created the workspace, and may therefore seed it. */
  bootstrapped: boolean;
}

/**
 * Resolves the workspace to run against.
 *
 * A supplied workspace id is authoritative: the account comes from the workspace record and the
 * operator from that account's owner, so the documented RADIOSO_EVAL_WORKSPACE_ID is enough on its
 * own. Anything missing is an error rather than a reason to substitute a fresh workspace — quietly
 * running somewhere else is how a run reports on a workspace nobody asked about.
 */
const resolveTarget = async (deps: Deps, flags: Flags): Promise<EvalTarget> => {
  if (!flags.workspaceId) {
    const email = `copilot-eval+${randomUUID()}@example.invalid`;
    const registration = await deps.authService.register({ email, password: `Ev@l-${randomUUID()}` });
    const agent = await deps.agentService.resolve(registration.workspaceId);
    console.log(`Bootstrapped disposable workspace ${registration.workspaceId} / agent ${agent.id}`);
    return {
      workspaceId: registration.workspaceId,
      agentId: agent.id,
      accountId: registration.accountId,
      operatorUserId: registration.userId,
      bootstrapped: true,
    };
  }

  const workspace = await deps.workspaceRepository.findById(flags.workspaceId);
  if (!workspace) throw new Error(`Workspace ${flags.workspaceId} not found.`);

  const agentId = flags.agentId || workspace.defaultAgentId || (await deps.agentService.resolve(workspace.id)).id;

  const members = await deps.accountAccessService.listAccountUsers(workspace.accountId);
  const active = members.filter((member) => member.status === "active");
  const operator = flags.operatorUserId
    ? active.find((member) => member.userId === flags.operatorUserId)
    : active.find((member) => member.role === "owner") ?? active[0];
  if (!operator) {
    throw new Error(
      flags.operatorUserId
        ? `Operator ${flags.operatorUserId} is not an active member of the account owning workspace ${workspace.id}.`
        : `Account ${workspace.accountId} has no active member to run as.`,
    );
  }

  console.log(`Running against workspace ${workspace.id} / agent ${agentId} as ${operator.email}`);
  return {
    workspaceId: workspace.id,
    agentId,
    accountId: workspace.accountId,
    operatorUserId: operator.userId,
    bootstrapped: false,
  };
};

const SEED_QUESTION = "How much is shipping to Italy?";
const SEED_ANSWER = "Shipping to Italy is nine euro.";

/**
 * Gives a freshly bootstrapped workspace the minimum history the cases read: one customer
 * conversation with an answered turn, and one document. Both are written directly, because Ray only
 * reads them — driving a real chat turn would need a document worker and spend a model call to
 * produce something no assertion looks at.
 *
 * Only ever runs against a workspace this script created. Writing fixtures into an operator's real
 * workspace would be a surprise, and the whole reason to point the suite at one is that it already
 * holds the history worth measuring against.
 */
const seedBootstrappedWorkspace = async (deps: Deps, target: EvalTarget): Promise<void> => {
  const conversation = await deps.conversationRepository.create(target.workspaceId, target.agentId, "web");
  await deps.messageRepository.create({
    conversationId: conversation.id,
    workspaceId: target.workspaceId,
    role: "user",
    content: SEED_QUESTION,
  });
  const answer = await deps.messageRepository.create({
    conversationId: conversation.id,
    workspaceId: target.workspaceId,
    role: "assistant",
    content: SEED_ANSWER,
  });
  await deps.documentIngestionService.ingest({
    workspaceId: target.workspaceId,
    title: "Shipping rates",
    content: "Shipping within the EU costs nine euro. Italy is included in the EU rate.",
  });
  // A written complaint on that answer, which is what puts the turn in front of quality_signals and
  // the triage digest. Ray's cases about acting on complaints have nothing to read without it.
  await new AnswerFeedbackService(deps.connectorDb.kysely).upsert({
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    assistantMessageId: answer.id,
    value: "down",
    comment: "That shipping price is wrong.",
    actor: { type: "authenticated_user", id: target.operatorUserId, accountId: target.accountId, userId: target.operatorUserId },
  });
  await deps.routineDefinitionService.createDraft(target.workspaceId, target.agentId, {
    name: COPILOT_EVAL_ROUTINE_NAME,
    activation: { triggerDescription: "When a customer asks where their order is", gateRef: null, priority: 10, reentryMode: "always" },
    slots: [],
    steps: [{ stableStepId: "ask_order_number", kind: "chat", instruction: "Ask for the order number.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    transitions: [{ fromStep: "ask_order_number", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
    terminals: [{ stableStepId: "done", kind: "complete", instruction: "Give the order's status.", ordinal: 0 }],
  });
  console.log("Seeded one answered conversation with a complaint, one document, and one draft routine.");
};

/**
 * Removes the copilot conversations this run created, named exactly.
 *
 * Every case drives a real copilot turn, which persists a conversation and its messages, and the
 * proposal cases persist a pending proposal on top. Against a workspace the operator actually uses,
 * that is the suite showing up in their Ray history and their approval queue.
 *
 * The ids come from the turns themselves rather than from diffing the conversation list before and
 * after. An operator investigating alongside the run — which is the whole point of `--workspace` —
 * would have their own new conversation caught by that diff and deleted, proposals and all.
 * Proposals cascade with the conversation, so deleting these is enough.
 */
const cleanUpCopilotArtifacts = async (
  deps: Deps,
  target: EvalTarget,
  createdConversationIds: ReadonlySet<string>,
): Promise<void> => {
  if (createdConversationIds.size === 0) return;
  try {
    for (const id of createdConversationIds) {
      await deps.copilotRepository.deleteConversation({
        id,
        workspaceId: target.workspaceId,
        operatorUserId: target.operatorUserId,
      });
    }
    console.log(`Cleaned up ${createdConversationIds.size} copilot conversation(s) this run created.`);
  } catch (error) {
    // Never mask the run's own failure with a cleanup failure; say what is left behind instead.
    console.warn(`Could not clean up this run's copilot conversations: ${(error as Error).message}`);
  }
};

/**
 * Drops the workspace this run registered, so a local database does not collect one seeded
 * workspace per run. Kept when the run failed, because a red run is exactly when someone wants to
 * open the workspace and look at what Ray was reading, and kept on request.
 *
 * The throwaway account and its user survive: no delete path is published for them. They are
 * identifiable by the `copilot-eval+…@example.invalid` address.
 */
const tearDownBootstrappedWorkspace = async (deps: Deps, target: EvalTarget, keep: boolean): Promise<void> => {
  if (!target.bootstrapped) return;
  if (keep) {
    console.log(`Kept bootstrapped workspace ${target.workspaceId} for inspection.`);
    return;
  }
  try {
    await deps.workspaceRepository.deleteByIdAndAccountId(target.workspaceId, target.accountId);
    console.log(`Removed bootstrapped workspace ${target.workspaceId}.`);
  } catch (error) {
    console.warn(`Could not remove bootstrapped workspace ${target.workspaceId}: ${(error as Error).message}`);
  }
};

/** What the target workspace can actually supply, probed once and shared by every case. */
const probeWorkspace = async (deps: Deps, target: EvalTarget): Promise<{
  satisfied: Set<CopilotEvalWorkspaceRequirement>;
  conversationId: string | null;
  routine: { id: string; name: string } | null;
}> => {
  const satisfied = new Set<CopilotEvalWorkspaceRequirement>();

  let conversationId: string | null = null;
  const { conversations } = await deps.chatHistoryService.listConversations(target.workspaceId, { limit: 20 });
  for (const summary of conversations) {
    const detail = await deps.chatHistoryService.getConversation(target.workspaceId, summary.id, { limit: 50 });
    if (detail.messages.some((message) => message.role === "assistant")) {
      conversationId = summary.id;
      satisfied.add("conversation_with_assistant_turn");
      break;
    }
  }

  const documents = await deps.documentIngestionService.summarizeWorkspace(target.workspaceId);
  if (documents.documentCount > 0) satisfied.add("document");

  // Scoped to the agent under test, because that is how the case reads it: the page context binds to
  // this agent and quality_signals filters by it. A workspace whose only complaints belong to
  // another agent would otherwise look able to run the case and hand Ray an empty result.
  const quality = await deps.qualitySignalsService.listLowQualityTurns(target.workspaceId, { limit: 1, agentId: target.agentId });
  if (quality.items.length > 0) satisfied.add("quality_signal");

  // Routine cases edit and publish, so they need a routine that is still a draft; proposing an
  // edit to a published one would revise a real routine in an operator's workspace. The publish
  // case additionally needs one that validates: against an invalid draft, Ray's correct refusal to
  // draft a publish would be scored as a behaviour regression.
  const drafts = (await deps.routineDefinitionService.list(target.workspaceId, target.agentId))
    .filter((candidate) => candidate.status === "draft");
  let routine = drafts[0] ?? null;
  for (const candidate of drafts) {
    if ((await deps.routineDefinitionService.validate(target.workspaceId, target.agentId, { id: candidate.id })).ok) {
      routine = candidate;
      satisfied.add("publishable_routine");
      break;
    }
  }
  if (routine) satisfied.add("routine");

  return { satisfied, conversationId, routine: routine ? { id: routine.id, name: routine.name } : null };
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  const dataset = parseCopilotEvalCases(copilotEvalCases);
  // The recorder refuses a partial baseline anyway; catching it here costs nothing and saves a
  // whole suite of model calls that could never be written.
  if (flags.updateBaseline && (flags.tags.length > 0 || flags.caseIds.length > 0)) {
    console.error("--update-baseline records the whole dataset, so it cannot be combined with --tag or --case. Run the full suite to record.");
    process.exitCode = 1;
    return;
  }
  // Recording against someone's real workspace records whatever that workspace held that day, and
  // running the suite there leaves copilot conversations and a pending proposal behind. A baseline
  // has to come from the seeded workspace this run builds, which is reproducible and disposable.
  if (flags.updateBaseline && flags.workspaceId) {
    console.error("--update-baseline records from the seeded throwaway workspace this run creates, so it cannot be combined with --workspace.");
    process.exitCode = 1;
    return;
  }
  const env = getEnv();
  if (flags.migrate) {
    console.log("Applying migrations…");
    await runMigrations(env.DATABASE_URL, createLogger("silent"));
  }
  const deps = buildDependencies(env);
  let target: EvalTarget | null = null;
  const createdCopilotConversationIds = new Set<string>();

  try {
    // Bound to a const as well so the closures below keep the non-null narrowing.
    const resolved = await resolveTarget(deps, flags);
    target = resolved;
    if (resolved.bootstrapped) await seedBootstrappedWorkspace(deps, resolved);

    const { satisfied, conversationId, routine } = await probeWorkspace(deps, resolved);
    const selection = selectRunnableCopilotEvalCases(narrowDataset(dataset, flags), satisfied);
    for (const skipped of selection.unmet) {
      console.warn(`SKIPPED ${skipped.caseId} "${skipped.name}" — workspace supplies no ${skipped.missing.join(", ")}.`);
    }
    if (selection.runnable.length === 0) {
      console.error("No case can run against this workspace. Point --workspace at one with real history.");
      process.exitCode = 1;
      return;
    }
    // Refused before spending a single model call: a baseline missing the cases this workspace
    // could not run reads exactly like a baseline where those cases do not exist, and every later
    // run then compares against it.
    if (flags.updateBaseline && selection.unmet.length > 0) {
      console.error(
        `Refusing to record a partial baseline: ${selection.unmet.length} case(s) cannot run here. ` +
        "Point --workspace at a workspace holding the records they read.",
      );
      process.exitCode = 1;
      return;
    }

    const cases = bindToLiveWorkspace(selection.runnable, { agentId: resolved.agentId, conversationId, routine });
    if (flags.samples > 1) {
      console.log(`Sampling each of ${cases.length} case(s) ${flags.samples}× (pass threshold ${flags.passThreshold})…`);
    }

    const { reports, outcomes } = await runCopilotEvalSuite(
      cases,
      {
        run: async (evalCase) => {
          const observed = await observeCopilotTurn(evalCase, {
            prompt: deps.copilotPrompt,
            tools: deps.copilotToolCatalog,
            capabilityRunner: deps.copilotCapabilityRunner,
            workspaceRouteKeyResolver: deps.copilotWorkspaceRouteKeyResolver,
            repository: deps.copilotRepository,
            workspaceId: resolved.workspaceId,
            accountId: resolved.accountId,
            operatorUserId: resolved.operatorUserId,
          });
          if (observed.conversationId) createdCopilotConversationIds.add(observed.conversationId);
          return observed;
        },
      },
      { fidelity: "live", samples: flags.samples, passThreshold: flags.passThreshold },
    );

    const violations = copilotHardGateViolations(cases, reports);
    const handoffGaps = copilotHandoffGaps(cases, reports);
    const baseline = loadBaseline();
    console.log(`\n${formatCopilotEvalReport(reports, { fidelity: "live", violations, handoffGaps })}\n`);

    if (flags.updateBaseline) {
      // buildCopilotBaselineFile throws on a never-list violation rather than recording it, so a
      // refusal that stopped working cannot be blessed as the new normal by re-running with the flag.
      // The full dataset, not the subset that ran: the recorder is what enforces that the two match.
      writeFileSync(BASELINE_PATH, `${JSON.stringify(buildCopilotBaselineFile(dataset, reports, new Date().toISOString()), null, 2)}\n`);
      console.log(`Baseline updated: ${path.relative(process.cwd(), BASELINE_PATH)}`);
      return;
    }

    if (violations.length > 0) {
      console.error(`${violations.length} never-list case(s) did not hold. This is a hard gate, not a baseline comparison.`);
      process.exitCode = 1;
    }

    if (!isBaselineInitialized(baseline)) {
      console.error("Baseline is uninitialized — regression gating is disabled. Run with --update-baseline after a known-good run.");
      process.exitCode = 1;
    }

    const diff = diffAgainstBaseline(outcomes, baseline);
    if (diff.regressions.length > 0) {
      console.error(`${diff.regressions.length} case(s) regressed against the baseline: ${diff.regressions.map((entry) => entry.caseId).join(", ")}`);
      process.exitCode = 1;
    }
    // Not a regression, but not "unchanged" either: say so, or a smoke run reads as a clean one.
    if (diff.underSampled.length > 0) {
      console.warn(
        `${diff.underSampled.length} case(s) look worse than the baseline but this run sampled less deeply than it did; ` +
        `re-run with --samples ${Math.max(...diff.underSampled.map((entry) => entry.baselineSamples))} to decide: ` +
        diff.underSampled.map((entry) => entry.caseId).join(", "),
      );
    }
    // The half a status comparison cannot see: a case recorded `fail` that used to pass some of the
    // time and now never does holds its status and is silently worse.
    if (diff.rateRegressions.length > 0) {
      console.error(
        `${diff.rateRegressions.length} case(s) pass materially less often than the baseline recorded: ` +
        diff.rateRegressions.map((entry) => `${entry.caseId} ${entry.from} -> ${entry.to}`).join(", "),
      );
      process.exitCode = 1;
    }
  } finally {
    if (target) {
      await cleanUpCopilotArtifacts(deps, target, createdCopilotConversationIds);
      await tearDownBootstrappedWorkspace(deps, target, flags.keepWorkspace || process.exitCode === 1);
    }
    const shutdown = (deps as { shutdown?: () => Promise<void> }).shutdown;
    if (shutdown) await shutdown.call(deps);
  }
};

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
