/**
 * Headless runner for the committed conversation-quality suite.
 *
 *   pnpm run evals                     # deterministic layer, diff against baseline
 *   pnpm run evals -- --update-baseline # re-record baseline.json
 *   pnpm run evals -- --tag routine     # only cases carrying a tag (repeatable)
 *   pnpm run evals -- --tag quick-reply --judge-tag quick-reply
 *                                       # also grade llm_judge assertions on cases with that tag
 *   pnpm run evals:voice                # the voice cases instead, through the voice runtime's door
 *
 * It assembles the real application stack (buildDependencies), seeds the fixture corpus,
 * directives, and routines onto a target agent, drives each live case through the composed
 * WorkbenchReplayRunner and each `review` case through ChatService.review() on the published
 * agent, scores the observed output, and exits non-zero if any case regressed relative to
 * backend/tests/fixtures/conversation-quality/baseline.json.
 *
 * REQUIREMENTS (this is a live path, not a unit test):
 *   - DATABASE_URL to a Postgres with pgvector, migrated.
 *   - Provider credentials (LLM_PROVIDER + OPENAI_API_KEY / Claude equivalent) for real
 *     model output — the whole point is a genuine quality signal.
 *   - A running document worker (or run this against the dev stack) so ingested corpus
 *     documents get chunked + embedded before retrieval.
 *   - RADIOSO_EVAL_WORKSPACE_ID / RADIOSO_EVAL_AGENT_ID pointing at a disposable agent to
 *     seed. The suite mutates that agent's directives and routines, and publishes it when the
 *     run includes review cases or runs the voice channel; the voice channel also turns voice on
 *     for it, so point a voice run at an agent of its own.
 *   - A non-production NODE_ENV when the run publishes: publishing needs the skills
 *     the seeded routines dispatch, which the runner adds as webhook skills on a loopback
 *     destination for the length of the publication only.
 *
 * `--channel voice` runs the voice cases (tests/fixtures/conversation-quality/voiceCases.ts) instead,
 * through `runVoiceEvals.ts`: whole calls through the voice runtime's door, gated on the wire against
 * voice-baseline.json, with each case's latency reported and never gated. The channels share the
 * target, corpus, publishing and baseline gate in `evalRunSupport.ts`.
 *
 * The runner scores the deterministic layer and drops `llm_judge` assertions, except on cases
 * carrying a tag named with `--judge-tag` (repeatable): those are graded by the eval layer's
 * LLM judge on the cheapest text model the configuration resolves, the rerank tier, unless
 * `--judge-model` names another. Judging is opt-in per tag because each graded assertion is
 * one more model call per sample, and an ungated judge would make every nightly case pay it.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv, type Env } from "../src/app/config/env.js";
import { buildLlmRegistry } from "../src/app/server/builders/integrations.js";
import { buildDependencies } from "../src/app/server/dependencies.js";
import { runMigrations } from "../src/db/runMigrations.js";
import { createLogger } from "../src/shared/observability/logger.js";
import { projectInternalAgentConfig } from "../src/modules/agents/public.js";
import { ChatGatewayLlmJudge } from "../src/modules/eval/composition.js";
import { resolveLlmConfig } from "../src/shared/infra/llm/providerConfig.js";
import {
  buildBaselineFile,
  diffAgainstBaseline,
  formatReport,
  mergeBaselineFile,
  parseConversationQualityCases,
  runConversationQualitySuiteSampled,
  summarizeRun,
  type BaselineFile,
  type ConversationQualityCase,
} from "../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../tests/fixtures/conversation-quality/cases.js";
import { conversationQualityDirectives } from "../tests/fixtures/conversation-quality/directives.js";
import { conversationQualityRoutines, CREATE_RETURN_TICKET_SKILL } from "../tests/fixtures/conversation-quality/routines.js";
import { createReviewTurnRunnerPort, createWorkbenchReplayRunnerPort } from "./evalRunnerAdapter.js";
import {
  closeDependencies,
  ensureTarget,
  filterByTags,
  gateOnBaseline,
  loadBaselineFile,
  publishAgent,
  seedCorpus,
  waitForDocumentsReady,
  type EvalChannel,
  type EvalDeps,
  type EvalRunFlags,
} from "./evalRunSupport.js";
import { runVoiceChannel } from "./runVoiceEvals.js";

const BASELINE_PATH = fileURLToPath(
  new URL("../tests/fixtures/conversation-quality/baseline.json", import.meta.url),
);

const parseChannel = (value: string | undefined): EvalChannel => {
  if (value === "text" || value === "voice") return value;
  throw new Error(`--channel takes text or voice, not ${value ?? "nothing"}.`);
};

const parseFlags = (argv: string[]): EvalRunFlags => {
  const flags: EvalRunFlags = {
    updateBaseline: false,
    judge: false,
    judgeTags: [],
    tags: [],
    workspaceId: process.env.RADIOSO_EVAL_WORKSPACE_ID ?? "",
    agentId: process.env.RADIOSO_EVAL_AGENT_ID ?? "",
    samples: 1,
    passThreshold: 1,
    migrate: false,
    channel: "text",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--update-baseline") flags.updateBaseline = true;
    else if (arg === "--judge") flags.judge = true;
    else if (arg === "--migrate") flags.migrate = true;
    else if (arg === "--tag") flags.tags.push(argv[++index] ?? "");
    else if (arg === "--judge-tag") flags.judgeTags.push(argv[++index] ?? "");
    else if (arg === "--judge-model") flags.judgeModel = argv[++index] || undefined;
    else if (arg === "--workspace") flags.workspaceId = argv[++index] ?? "";
    else if (arg === "--agent") flags.agentId = argv[++index] ?? "";
    else if (arg === "--samples") flags.samples = Math.max(1, Number.parseInt(argv[++index] ?? "1", 10) || 1);
    else if (arg === "--pass-threshold") flags.passThreshold = Math.min(1, Math.max(0, Number.parseFloat(argv[++index] ?? "1") || 1));
    else if (arg === "--channel") flags.channel = parseChannel(argv[++index]);
  }
  return flags;
};

const loadBaseline = (): BaselineFile => {
  const { latency: _latency, ...baseline } = loadBaselineFile(BASELINE_PATH);
  return baseline;
};

/**
 * Keeps `llm_judge` assertions only on cases carrying one of `judgeTags`, so a run grades
 * exactly the cases it opted in and the rest score their deterministic layer.
 */
export const scopeJudgeAssertions = (
  cases: readonly ConversationQualityCase[],
  judgeTags: readonly string[],
): ConversationQualityCase[] =>
  cases.map((evalCase) => (evalCase.tags ?? []).some((tag) => judgeTags.includes(tag))
    ? evalCase
    : {
        ...evalCase,
        assertions: evalCase.assertions.filter((assertion) => assertion.type !== "llm_judge"),
      });

/**
 * The eval layer's LLM judge on the cheapest text model the configuration resolves: the
 * rerank tier's provider and model, unless `judgeModel` names another on that provider.
 */
const createSuiteJudge = (env: Env, judgeModel: string | undefined): { judge: ChatGatewayLlmJudge; model: string } => {
  const { rerank } = resolveLlmConfig(env);
  const model = judgeModel ?? rerank.model;
  const registry = buildLlmRegistry(
    { ...env, LLM_CHAT_PROVIDER: rerank.provider, LLM_CHAT_MODEL: model },
    createLogger("silent"),
  );
  return { judge: new ChatGatewayLlmJudge(registry.createChatGateway()), model };
};

/**
 * Remap the fixture's stable document/routine ids to the ids the live stack assigned when
 * we seeded them, so id-based assertions match regardless of how ingestion/publish mint
 * ids. Both maps are built from the seed step's return values.
 */
const remapIds = (
  cases: ConversationQualityCase[],
  documentIds: Map<string, string>,
  routineIds: Map<string, string>,
): ConversationQualityCase[] =>
  cases.map((evalCase) => ({
    ...evalCase,
    routineStartState: evalCase.routineStartState
      ? {
          ...evalCase.routineStartState,
          routineId: routineIds.get(evalCase.routineStartState.routineId) ?? evalCase.routineStartState.routineId,
        }
      : evalCase.routineStartState,
    assertions: evalCase.assertions.map((assertion) => {
      if ("documentId" in assertion && documentIds.has(assertion.documentId)) {
        return { ...assertion, documentId: documentIds.get(assertion.documentId)! };
      }
      if ("documentIds" in assertion) {
        return { ...assertion, documentIds: assertion.documentIds.map((id) => documentIds.get(id) ?? id) };
      }
      if ("routineId" in assertion && routineIds.has(assertion.routineId)) {
        return { ...assertion, routineId: routineIds.get(assertion.routineId)! };
      }
      return assertion;
    }),
  }));

const seedFixtures = async (
  deps: EvalDeps,
  flags: EvalRunFlags,
): Promise<{ documentIds: Map<string, string>; routineIds: Map<string, string> }> => {
  const documentIds = await seedCorpus(deps, flags);
  const routineIds = new Map<string, string>();

  for (const directive of conversationQualityDirectives) {
    try {
      await deps.authoredDirectiveService.create(flags.workspaceId, flags.agentId, {
        name: directive.name,
        condition: directive.condition,
        action: directive.action,
        priority: directive.priority,
        requiredCapabilities: directive.requiredCapabilities,
        dependsOn: directive.dependsOn,
        excludes: directive.excludes,
        routes: directive.routes,
        tags: directive.tags,
        description: directive.description,
        binding: directive.binding,
        metadata: directive.metadata,
      });
    } catch (error) {
      console.warn(`  seed: directive "${directive.name}" skipped — ${(error as Error).message}`);
    }
  }

  for (const routine of conversationQualityRoutines) {
    try {
      const draft = await deps.routineDefinitionService.createDraft(flags.workspaceId, flags.agentId, {
        name: routine.name,
        enabled: routine.enabled,
        activation: routine.activation,
        slots: routine.slots,
        steps: routine.steps,
        transitions: routine.transitions,
        terminals: routine.terminals,
        completionExport: routine.completionExport,
        exposure: routine.exposure,
      });
      // A routine goes live the moment it is created — there is no separate publish step any
      // more, the agent's own Review & Publish is the one release gate.
      routineIds.set(routine.id, draft.routine.id);
    } catch (error) {
      // A repeat run against the same disposable agent collides on the
      // (agent_id, name, version) uniqueness. The routine already exists, so resolve its
      // live id by name and fill the map — otherwise routine assertions would keep the
      // fixture id and spuriously regress.
      const existing = (await deps.routineDefinitionService.list(flags.workspaceId, flags.agentId)).find(
        (candidate) => candidate.name === routine.name && candidate.enabled,
      );
      if (existing) {
        routineIds.set(routine.id, existing.id);
      } else {
        console.warn(`  seed: routine "${routine.name}" skipped — ${(error as Error).message}`);
      }
    }
  }

  return { documentIds, routineIds };
};

/** Only a review case runs the published revision, so only a run that selects one publishes the agent. */
export const needsPublishedAgent = (cases: readonly ConversationQualityCase[]): boolean =>
  cases.some((evalCase) => evalCase.executionMode === "review");

/**
 * The skills the seeded routines dispatch. Publishing refuses a routine whose tool step names a
 * skill the agent lacks, so the agent holds these skills while it is published.
 */
export const seededRoutineSkillNames: readonly string[] = [CREATE_RETURN_TICKET_SKILL];

const ROUTINE_SKILL_DESTINATION = {
  name: "Conversation-quality evals (publication only)",
  // Nothing delivers to it, since the skills are gone before any case runs, and a loopback
  // address could not reach anything outside the machine regardless.
  url: "http://127.0.0.1/conversation-quality-skill",
};

/**
 * Gives the agent the routine skills as webhook skills while `run` runs, then removes them. With
 * them gone, a live case that reaches a skill step finds no such skill, exactly as it does in a
 * run without review cases, so live outcomes do not depend on which cases a run selects.
 */
const withRoutineSkills = async <T>(deps: EvalDeps, flags: EvalRunFlags, run: () => Promise<T>): Promise<T> => {
  const actor = { accountId: null };
  const destination = (await deps.webhookDestinations.list(flags.workspaceId))
    .find((candidate) => candidate.name === ROUTINE_SKILL_DESTINATION.name)
    ?? (await deps.webhookDestinations.create({ workspaceId: flags.workspaceId, ...ROUTINE_SKILL_DESTINATION, actor })).destination;
  // A run that died before its clean-up left these behind; they are removed with the new ones.
  const skills = (await deps.webhookSkillDefinitionService.list(flags.workspaceId, flags.agentId))
    .filter((skill) => seededRoutineSkillNames.includes(skill.skillName));
  try {
    for (const skillName of seededRoutineSkillNames.filter((name) => !skills.some((skill) => skill.skillName === name))) {
      skills.push(await deps.webhookSkillDefinitionService.create(flags.workspaceId, flags.agentId, {
        skillName,
        destinationId: destination.id,
        boundPayload: {},
        exposedPayload: {},
        enabled: true,
      }));
    }
    return await run();
  } finally {
    for (const skill of skills) {
      await deps.webhookSkillDefinitionService.remove(flags.workspaceId, flags.agentId, skill.id);
    }
    await deps.webhookDestinations.delete(flags.workspaceId, destination.id, actor);
  }
};

/**
 * Publishes the seeded agent and returns the published revision's id. A review case runs the
 * published revision, as the email channel does, while a live case replays the draft
 * configuration directly; publishing makes both see the seeded directives and routines.
 */
const publishSeededAgent = (deps: EvalDeps, flags: EvalRunFlags): Promise<string> =>
  withRoutineSkills(deps, flags, () => publishAgent(deps, flags));

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.judge) {
    // Grading is opt-in per tag (see the header): an all-case judge would add a model
    // call to every judged assertion of every nightly sample.
    console.error("--judge grades every case; pass --judge-tag <tag> to grade the cases carrying that tag.");
    process.exit(2);
  }

  const dataset = parseConversationQualityCases(conversationQualityCases);
  const env = getEnv();
  if (flags.migrate) {
    console.log("Applying migrations…");
    await runMigrations(env.DATABASE_URL, createLogger("silent"));
  }
  // The routine skills' destination is a loopback address, which a default stack refuses.
  const deps = buildDependencies({ ...env, WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: true });

  try {
    const target = await ensureTarget(deps, flags);
    flags.workspaceId = target.workspaceId;
    flags.agentId = target.agentId;
    if (flags.channel === "voice") {
      await runVoiceChannel(deps, flags, target);
      return;
    }
    console.log(`Seeding fixtures onto agent ${flags.agentId} in workspace ${flags.workspaceId}…`);
    const { documentIds, routineIds } = await seedFixtures(deps, flags);
    await waitForDocumentsReady(deps, flags.workspaceId, documentIds);

    const agent = await deps.agentRepository.findByIdAndWorkspaceId(flags.agentId, flags.workspaceId);
    if (!agent) {
      throw new Error(`Agent ${flags.agentId} not found in workspace ${flags.workspaceId}.`);
    }
    const baselineAgentConfig = projectInternalAgentConfig(agent);

    let cases = filterByTags(dataset, flags.tags);
    cases = remapIds(cases, documentIds, routineIds);
    // llm_judge assertions are graded only on the cases a --judge-tag opted in.
    cases = scopeJudgeAssertions(cases, flags.judgeTags);
    const suiteJudge = flags.judgeTags.length > 0 ? createSuiteJudge(env, flags.judgeModel) : null;
    if (suiteJudge) {
      console.log(`Grading llm_judge assertions on cases tagged ${flags.judgeTags.join(", ")} with ${suiteJudge.model}.`);
    }

    const replayPort = createWorkbenchReplayRunnerPort(deps.workbenchReplayRunner, {
      workspaceId: flags.workspaceId,
      agentId: flags.agentId,
      baselineAgentConfig,
    });
    const reviewPort = needsPublishedAgent(cases)
      ? createReviewTurnRunnerPort(
          { chat: deps.chatService, conversations: deps.conversationRepository, messages: deps.messageRepository },
          {
            workspaceId: flags.workspaceId,
            agentId: flags.agentId,
            agentRevisionId: await publishSeededAgent(deps, flags),
          },
        )
      : {};
    const port = { ...replayPort, ...reviewPort };

    if (flags.samples > 1) {
      console.log(`Sampling each case ${flags.samples}× (pass threshold ${flags.passThreshold})…`);
    }
    const { reports, outcomes } = await runConversationQualitySuiteSampled(cases, port, {
      workspaceId: flags.workspaceId,
      samples: flags.samples,
      passThreshold: flags.passThreshold,
      ...(suiteJudge ? { judge: suiteJudge.judge } : {}),
    });

    const summary = summarizeRun(outcomes);
    const baseline = loadBaseline();
    const diff = diffAgainstBaseline(outcomes, baseline, { passThreshold: flags.passThreshold });
    console.log(`\n${formatReport(reports, diff, summary)}\n`);

    if (flags.updateBaseline) {
      if (
        flags.tags.length > 0 &&
        baseline.passThreshold !== undefined &&
        baseline.passThreshold !== flags.passThreshold
      ) {
        throw new Error(
          "A filtered baseline update cannot change the pass threshold; re-record the full suite at the new threshold.",
        );
      }
      const generatedAt = new Date().toISOString();
      const updatedBaseline = flags.tags.length > 0
        ? mergeBaselineFile(baseline, outcomes, generatedAt, flags.passThreshold)
        : buildBaselineFile(outcomes, generatedAt, flags.passThreshold);
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify(updatedBaseline, null, 2)}\n`,
      );
      console.log(`Baseline updated: ${path.relative(process.cwd(), BASELINE_PATH)}`);
      return;
    }

    gateOnBaseline(baseline, diff, "pnpm run evals:update-baseline");
  } finally {
    await closeDependencies(deps);
  }
};

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
