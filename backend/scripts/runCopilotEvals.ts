/**
 * Headless runner for the committed Ray behaviour suite (issue #1054).
 *
 *   pnpm run evals:copilot                      # real model, diff against the baseline
 *   pnpm run evals:copilot -- --update-baseline # re-record baseline.json after an intended change
 *   pnpm run evals:copilot -- --tag never_list  # only cases carrying a tag (repeatable)
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
import { createLogger } from "../src/shared/observability/logger.js";
import { diffAgainstBaseline, isBaselineInitialized, type BaselineFile } from "../src/modules/eval/suite/index.js";
import {
  buildCopilotBaselineFile,
  copilotHardGateViolations,
  formatCopilotEvalReport,
  parseCopilotEvalCases,
  runCopilotEvalSuite,
  selectRunnableCopilotEvalCases,
  type CopilotEvalCase,
  type CopilotEvalWorkspaceRequirement,
} from "../tests/support/copilotEvalSuite.js";
import { observeCopilotTurn } from "../tests/support/copilotEvalRunner.js";
import { copilotEvalCases } from "../tests/fixtures/copilot-evals/cases.js";

const BASELINE_PATH = fileURLToPath(new URL("../tests/fixtures/copilot-evals/baseline.json", import.meta.url));

interface Flags {
  updateBaseline: boolean;
  tags: string[];
  workspaceId: string;
  agentId: string;
  operatorUserId: string;
  migrate: boolean;
}

const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = {
    updateBaseline: false,
    tags: [],
    workspaceId: process.env.RADIOSO_EVAL_WORKSPACE_ID ?? "",
    agentId: process.env.RADIOSO_EVAL_AGENT_ID ?? "",
    operatorUserId: process.env.RADIOSO_EVAL_OPERATOR_USER_ID ?? "",
    migrate: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--update-baseline") flags.updateBaseline = true;
    else if (arg === "--migrate") flags.migrate = true;
    else if (arg === "--tag") flags.tags.push(argv[++index] ?? "");
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

const filterByTags = (cases: CopilotEvalCase[], tags: string[]): CopilotEvalCase[] =>
  tags.length === 0 ? cases : cases.filter((entry) => (entry.tags ?? []).some((tag) => tags.includes(tag)));

/**
 * Rewrites the fixture's placeholder ids to the live workspace's own. Cases name an agent and a
 * conversation so the model has something concrete to reason about; against a live stack those ids
 * have to exist or every tool call returns "not found" and the run measures nothing.
 */
const bindToLiveWorkspace = (
  cases: CopilotEvalCase[],
  live: { agentId: string; conversationId: string | null },
): CopilotEvalCase[] =>
  cases.map((entry) => ({
    ...entry,
    pageContext: {
      ...entry.pageContext,
      agentId: entry.pageContext.agentId ? live.agentId : null,
      conversationId: entry.pageContext.conversationId ? live.conversationId : null,
    },
  }));

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
  await deps.messageRepository.create({
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
  console.log("Seeded one conversation and one document into the bootstrapped workspace.");
};

/** What the target workspace can actually supply, probed once and shared by every case. */
const probeWorkspace = async (deps: Deps, target: EvalTarget): Promise<{
  satisfied: Set<CopilotEvalWorkspaceRequirement>;
  conversationId: string | null;
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

  const quality = await deps.qualitySignalsService.listLowQualityTurns(target.workspaceId, { limit: 1 });
  if (quality.items.length > 0) satisfied.add("quality_signal");

  return { satisfied, conversationId };
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  const dataset = parseCopilotEvalCases(copilotEvalCases);
  const env = getEnv();
  if (flags.migrate) {
    console.log("Applying migrations…");
    await runMigrations(env.DATABASE_URL, createLogger("silent"));
  }
  const deps = buildDependencies(env);

  try {
    const target = await resolveTarget(deps, flags);
    if (target.bootstrapped) await seedBootstrappedWorkspace(deps, target);

    const { satisfied, conversationId } = await probeWorkspace(deps, target);
    const selection = selectRunnableCopilotEvalCases(filterByTags(dataset, flags.tags), satisfied);
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

    const cases = bindToLiveWorkspace(selection.runnable, { agentId: target.agentId, conversationId });

    const { reports, outcomes } = await runCopilotEvalSuite(
      cases,
      {
        run: (evalCase) => observeCopilotTurn(evalCase, {
          prompt: deps.copilotPrompt,
          tools: deps.copilotToolCatalog,
          capabilityRunner: deps.copilotCapabilityRunner,
          workspaceRouteKeyResolver: deps.copilotWorkspaceRouteKeyResolver,
          repository: deps.copilotRepository,
          workspaceId: target.workspaceId,
          accountId: target.accountId,
          operatorUserId: target.operatorUserId,
        }),
      },
      { fidelity: "live" },
    );

    const violations = copilotHardGateViolations(cases, outcomes);
    const baseline = loadBaseline();
    console.log(`\n${formatCopilotEvalReport(reports, violations, "live")}\n`);

    if (flags.updateBaseline) {
      // buildCopilotBaselineFile throws on a never-list violation rather than recording it, so a
      // refusal that stopped working cannot be blessed as the new normal by re-running with the flag.
      writeFileSync(BASELINE_PATH, `${JSON.stringify(buildCopilotBaselineFile(cases, outcomes, new Date().toISOString()), null, 2)}\n`);
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
  } finally {
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
