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
 *   - RADIOSO_EVAL_WORKSPACE_ID / RADIOSO_EVAL_AGENT_ID for a disposable workspace, or none, in
 *     which case a throwaway account is registered.
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
  type CopilotEvalCase,
} from "../tests/support/copilotEvalSuite.js";
import { observeCopilotTurn } from "../tests/support/copilotEvalRunner.js";
import { copilotEvalCases } from "../tests/fixtures/copilot-evals/cases.js";

const BASELINE_PATH = fileURLToPath(new URL("../tests/fixtures/copilot-evals/baseline.json", import.meta.url));

interface Flags {
  updateBaseline: boolean;
  tags: string[];
  workspaceId: string;
  agentId: string;
  accountId: string;
  operatorUserId: string;
  migrate: boolean;
}

const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = {
    updateBaseline: false,
    tags: [],
    workspaceId: process.env.RADIOSO_EVAL_WORKSPACE_ID ?? "",
    agentId: process.env.RADIOSO_EVAL_AGENT_ID ?? "",
    accountId: process.env.RADIOSO_EVAL_ACCOUNT_ID ?? "",
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
    if (!flags.workspaceId || !flags.agentId || !flags.accountId || !flags.operatorUserId) {
      const email = `copilot-eval+${randomUUID()}@example.invalid`;
      const registration = await deps.authService.register({ email, password: `Ev@l-${randomUUID()}` });
      const agent = await deps.agentService.resolve(registration.workspaceId);
      flags.workspaceId = registration.workspaceId;
      flags.agentId = agent.id;
      flags.accountId = registration.accountId;
      flags.operatorUserId = registration.userId;
      console.log(`Bootstrapped disposable workspace ${flags.workspaceId} / agent ${flags.agentId}`);
    }

    // Cases that put a conversation on screen need one that exists. A workspace with no history
    // simply leaves those page contexts empty rather than pointing at an id that resolves to
    // nothing, which would read as a tool failure instead of an empty workspace.
    const { conversations } = await deps.chatHistoryService.listConversations(flags.workspaceId, { limit: 1 });
    const conversationId = conversations[0]?.id ?? null;
    if (!conversationId) {
      console.warn("No customer conversation in this workspace; conversation-scoped cases run without page context.");
    }

    const cases = bindToLiveWorkspace(filterByTags(dataset, flags.tags), { agentId: flags.agentId, conversationId });

    const { reports, outcomes } = await runCopilotEvalSuite(
      cases,
      {
        run: (evalCase) => observeCopilotTurn(evalCase, {
          prompt: deps.copilotPrompt,
          tools: deps.copilotToolCatalog,
          capabilityRunner: deps.copilotCapabilityRunner,
          workspaceRouteKeyResolver: deps.copilotWorkspaceRouteKeyResolver,
          repository: deps.copilotRepository,
          workspaceId: flags.workspaceId,
          accountId: flags.accountId,
          operatorUserId: flags.operatorUserId,
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
