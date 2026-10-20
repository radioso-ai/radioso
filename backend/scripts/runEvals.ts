/**
 * Headless runner for the committed conversation-quality suite.
 *
 *   pnpm run evals                     # deterministic layer, diff against baseline
 *   pnpm run evals -- --update-baseline # re-record baseline.json
 *   pnpm run evals -- --tag routine     # only cases carrying a tag (repeatable)
 *   pnpm run evals -- --tag quick-reply --judge-tag quick-reply
 *                                       # also grade llm_judge assertions on cases with that tag
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
 *     run includes review cases.
 *   - A non-production NODE_ENV when the run includes review cases: publishing needs the skills
 *     the seeded routines dispatch, which the runner adds as webhook skills on a loopback
 *     destination for the length of the publication only.
 *
 * The runner scores the deterministic layer and drops `llm_judge` assertions, except on cases
 * carrying a tag named with `--judge-tag` (repeatable): those are graded by the eval layer's
 * LLM judge on the cheapest text model the configuration resolves, the rerank tier, unless
 * `--judge-model` names another. Judging is opt-in per tag because each graded assertion is
 * one more model call per sample, and an ungated judge would make every nightly case pay it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
  hasBaselineGateFailures,
  isBaselineInitialized,
  mergeBaselineFile,
  parseConversationQualityCases,
  runConversationQualitySuiteSampled,
  summarizeRun,
  type BaselineFile,
  type ConversationQualityCase,
} from "../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../tests/fixtures/conversation-quality/cases.js";
import { conversationQualityCorpus } from "../tests/fixtures/conversation-quality/corpus.js";
import { conversationQualityDirectives } from "../tests/fixtures/conversation-quality/directives.js";
import { conversationQualityRoutines, CREATE_RETURN_TICKET_SKILL } from "../tests/fixtures/conversation-quality/routines.js";
import { VOICE_EVAL_AGENT_VOICE_SETTINGS, VOICE_EVAL_FALLBACK_LINE } from "../tests/fixtures/voice-eval/agent.js";
import { voiceEvalCases } from "../tests/fixtures/voice-eval/cases.js";
import { voiceEvalRoutines } from "../tests/fixtures/voice-eval/routines.js";
import { createReviewTurnRunnerPort, createVoiceTurnRunnerPort, createWorkbenchReplayRunnerPort } from "./evalRunnerAdapter.js";

const BASELINE_PATH = fileURLToPath(
  new URL("../tests/fixtures/conversation-quality/baseline.json", import.meta.url),
);

interface Flags {
  updateBaseline: boolean;
  judge: boolean;
  judgeTags: string[];
  judgeModel?: string;
  tags: string[];
  workspaceId: string;
  agentId: string;
  samples: number;
  passThreshold: number;
  migrate: boolean;
}

const parseFlags = (argv: string[]): Flags => {
  const flags: Flags = {
    updateBaseline: false,
    judge: false,
    judgeTags: [],
    tags: [],
    workspaceId: process.env.RADIOSO_EVAL_WORKSPACE_ID ?? "",
    agentId: process.env.RADIOSO_EVAL_AGENT_ID ?? "",
    samples: 1,
    passThreshold: 1,
    migrate: false,
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
  }
  return flags;
};

/**
 * Resolves the workspace + agent to seed and run against. An explicit --workspace/--agent
 * (or RADIOSO_EVAL_* env) targets a specific disposable agent; otherwise a throwaway
 * account is registered so a fresh CI database is a one-liner. The agent is materialized
 * lazily via resolve().
 */
const ensureTarget = async (
  deps: Deps,
  flags: Flags,
): Promise<{ workspaceId: string; agentId: string }> => {
  if (flags.workspaceId && flags.agentId) {
    return { workspaceId: flags.workspaceId, agentId: flags.agentId };
  }
  const email = `eval-suite+${randomUUID()}@example.invalid`;
  const registration = await deps.authService.register({ email, password: `Ev@l-${randomUUID()}` });
  const agent = await deps.agentService.resolve(registration.workspaceId);
  console.log(`Bootstrapped disposable workspace ${registration.workspaceId} / agent ${agent.id}`);
  return { workspaceId: registration.workspaceId, agentId: agent.id };
};

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Reads the committed baseline. A missing file reads as an empty baseline, so the first recording
 * can create it and a run against it fails as uninitialized. A file that cannot be parsed throws,
 * naming it: read as empty, it would gate nothing, and a tag-filtered `--update-baseline` would
 * write every other case's entry away.
 */
export const loadBaseline = (baselinePath: string): BaselineFile => {
  let text: string;
  try {
    text = readFileSync(baselinePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { cases: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The baseline at ${baselinePath} is not valid JSON; restore it from git before running.`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The baseline at ${baselinePath} holds no JSON object; restore it from git before running.`);
  }
  const file = parsed as Partial<BaselineFile>;
  return { generatedAt: file.generatedAt, passThreshold: file.passThreshold, cases: file.cases ?? {} };
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
 * Whether a voice assertion gates a live run. Live, the brain's speed decides the turn limit
 * (`VOICE_BEHAVIOR.turnLimitMs`, 10 s, exists for a stalled planner, and a real turn answers in a
 * few seconds however it is worded) and any expectation marked `latencyDependent`, such as "no
 * bridge" on a quick reply, which the 2.5 s stall bridge breaks whenever the planner is slow.
 * Those are latency facts live and behaviour facts only where the brain is scripted, so the
 * deterministic half, which scores the unscoped case, keeps asserting them.
 */
const gatesLiveVoiceRun = (assertion: ConversationQualityCase["assertions"][number]): boolean =>
  assertion.type !== "voice_turn_limit_reached"
  && !(assertion.type === "voice_bridge_emitted" && assertion.latencyDependent === true);

/**
 * What a live run drives of the voice cases, and gates each on: a `deterministicOnly` case is
 * skipped, and every other keeps only the assertions `gatesLiveVoiceRun` lets through. A voice
 * case left with nothing to gate would pass whatever the agent did, so it is refused before the
 * run seeds anything. Text cases pass through untouched.
 */
export const scopeVoiceCasesForLiveRun = (
  cases: readonly ConversationQualityCase[],
): ConversationQualityCase[] =>
  cases
    .filter((evalCase) => evalCase.voiceTurn?.deterministicOnly !== true)
    .map((evalCase) => {
      if (!evalCase.voiceTurn) {
        return evalCase;
      }
      const assertions = evalCase.assertions.filter(gatesLiveVoiceRun);
      if (assertions.length === 0) {
        throw new Error(
          `Voice case "${evalCase.id}" gates nothing live once its latency-dependent assertions are dropped; give it a behaviour assertion or mark it voiceTurn.deterministicOnly.`,
        );
      }
      return { ...evalCase, assertions };
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

const filterByTags = (cases: ConversationQualityCase[], tags: string[]): ConversationQualityCase[] =>
  tags.length === 0 ? cases : cases.filter((evalCase) => (evalCase.tags ?? []).some((tag) => tags.includes(tag)));

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

type Deps = ReturnType<typeof buildDependencies>;

/**
 * Seeds the fixture corpus, directives, and routines onto the target agent and returns
 * the fixture-id → live-id maps. Seeding is best-effort idempotent: a conflict (already
 * seeded from a prior run) is logged and skipped rather than aborting.
 */
const seedFixtures = async (
  deps: Deps,
  flags: Flags,
): Promise<{ documentIds: Map<string, string>; routineIds: Map<string, string> }> => {
  const documentIds = new Map<string, string>();
  const routineIds = new Map<string, string>();

  for (const document of conversationQualityCorpus) {
    try {
      const result = await deps.documentIngestionService.ingest({
        workspaceId: flags.workspaceId,
        title: document.title,
        content: document.content,
        externalDocumentId: document.id,
      });
      documentIds.set(document.id, result.documentId);
    } catch (error) {
      console.warn(`  seed: document "${document.title}" skipped — ${(error as Error).message}`);
    }
  }

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

/** Only a voice case drives the voice turn policy, so only a run that selects one turns voice on. */
export const needsVoiceSettings = (cases: readonly ConversationQualityCase[]): boolean =>
  cases.some((evalCase) => evalCase.voiceTurn !== undefined);

/**
 * Turns voice on for the seeded agent with the lines the voice cases need: a bridge line so a
 * case that searches has one to speak, and the fallback line `evalRunnerAdapter.ts`'s
 * `observeVoiceTurn` reads a turn's whole spoken text against to tell the turn limit apart from
 * a real answer (see `VOICE_EVAL_FALLBACK_LINE`). No `runtime` is bound: a voice case drives the
 * turn policy directly and starts no vendor session.
 */
const seedVoiceSettings = (deps: Deps, flags: Flags): Promise<unknown> =>
  deps.agentService.update(flags.workspaceId, flags.agentId, { voice: VOICE_EVAL_AGENT_VOICE_SETTINGS });

/**
 * Seeds `voiceEvalRoutines` (just the callback hand-off routine today) the same idempotent way
 * `seedFixtures` seeds the text suite's routines, but only while a voice case is selected: a
 * text-only run never carries this extra "ask for a callback" trigger alongside
 * `contactSupportRoutine`'s, so it cannot shift an already-recorded text case's routing.
 */
const seedVoiceRoutines = async (deps: Deps, flags: Flags): Promise<void> => {
  for (const routine of voiceEvalRoutines) {
    try {
      await deps.routineDefinitionService.createDraft(flags.workspaceId, flags.agentId, {
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
    } catch (error) {
      // A repeat run against the same disposable agent collides on the (agent_id, name, version)
      // uniqueness; the routine is already there, so there is nothing left to seed.
      const existing = (await deps.routineDefinitionService.list(flags.workspaceId, flags.agentId)).some(
        (candidate) => candidate.name === routine.name && candidate.enabled,
      );
      if (!existing) {
        console.warn(`  seed: voice routine "${routine.name}" skipped — ${(error as Error).message}`);
      }
    }
  }
};

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
const withRoutineSkills = async <T>(deps: Deps, flags: Flags, run: () => Promise<T>): Promise<T> => {
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
const publishSeededAgent = (deps: Deps, flags: Flags): Promise<string> =>
  withRoutineSkills(deps, flags, async () => {
    const state = await deps.agentRevisionService.state(flags.workspaceId, flags.agentId);
    if (state.status === "draft_clean" && state.publishedRevision) {
      return state.publishedRevision.id;
    }
    const candidate = await deps.agentRevisionService.createCandidate(flags.workspaceId, flags.agentId, state.draft.generation);
    const published = await deps.agentRevisionService.publish(flags.workspaceId, flags.agentId, null, {
      revisionId: candidate.id,
      expectedDraftGeneration: state.draft.generation,
      expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
      idempotencyKey: `conversation-quality-${candidate.id}`,
    });
    return published.revisionId;
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Blocks until every seeded document reaches the terminal `ready` status (chunked +
 * embedded, retrieval-eligible), so retrieval assertions don't race ingestion on a fresh
 * workspace. Fails loudly on a `failed` document or if processing never completes —
 * usually a sign the document worker isn't running.
 */
const waitForDocumentsReady = async (
  deps: Deps,
  workspaceId: string,
  documentIds: Map<string, string>,
  timeoutMs = 180_000,
): Promise<void> => {
  const pending = new Set(documentIds.values());
  if (pending.size === 0) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  console.log(`Waiting for ${pending.size} document(s) to finish processing…`);
  while (pending.size > 0) {
    for (const documentId of [...pending]) {
      const document = (await deps.documentIngestionService.getDocument(workspaceId, documentId)) as {
        status: string;
        failureReason?: string | null;
      };
      if (document.status === "ready") {
        pending.delete(documentId);
      } else if (document.status === "failed") {
        throw new Error(`Document ${documentId} failed processing: ${document.failureReason ?? "unknown"}`);
      }
    }
    if (pending.size === 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Documents not processed within ${timeoutMs}ms: ${[...pending].join(", ")}. Is the document worker running?`,
      );
    }
    await sleep(2_000);
  }
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.judge) {
    // Grading is opt-in per tag (see the header): an all-case judge would add a model
    // call to every judged assertion of every nightly sample.
    console.error("--judge grades every case; pass --judge-tag <tag> to grade the cases carrying that tag.");
    process.exit(2);
  }

  const dataset = parseConversationQualityCases([...conversationQualityCases, ...voiceEvalCases]);
  // Read before anything runs, so a damaged file stops the run before it seeds or samples.
  const baseline = loadBaseline(BASELINE_PATH);
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
    // A live run never gates a voice case on latency, and skips a deterministic-only one.
    let cases = scopeVoiceCasesForLiveRun(filterByTags(dataset, flags.tags));
    const runsVoiceCases = needsVoiceSettings(cases);

    console.log(`Seeding fixtures onto agent ${flags.agentId} in workspace ${flags.workspaceId}…`);
    const { documentIds, routineIds } = await seedFixtures(deps, flags);
    await waitForDocumentsReady(deps, flags.workspaceId, documentIds);
    if (runsVoiceCases) {
      await seedVoiceSettings(deps, flags);
      await seedVoiceRoutines(deps, flags);
    }

    const agent = await deps.agentRepository.findByIdAndWorkspaceId(flags.agentId, flags.workspaceId);
    if (!agent) {
      throw new Error(`Agent ${flags.agentId} not found in workspace ${flags.workspaceId}.`);
    }
    const baselineAgentConfig = projectInternalAgentConfig(agent);

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
    // A voice case runs the published revision too: the voice turn port streams through the
    // same chat answer path the completions route and a real session use, which answers for
    // the agent as it is published, not the draft `WorkbenchReplayRunner` replays directly.
    const agentRevisionId = needsPublishedAgent(cases) || runsVoiceCases
      ? await publishSeededAgent(deps, flags)
      : null;
    const reviewPort = needsPublishedAgent(cases) && agentRevisionId
      ? createReviewTurnRunnerPort(
          { chat: deps.chatService, conversations: deps.conversationRepository, messages: deps.messageRepository },
          { workspaceId: flags.workspaceId, agentId: flags.agentId, agentRevisionId },
        )
      : {};
    // A voice case drives the real voice turn policy over `deps.voiceTurns`, never the chat
    // reply's content, so it has its own port rather than riding the replay runner's.
    const voicePort = runsVoiceCases
      ? createVoiceTurnRunnerPort(deps.voiceTurns, {
          workspaceId: flags.workspaceId,
          agentId: flags.agentId,
          vendor: "generic",
          fallbackLine: VOICE_EVAL_FALLBACK_LINE,
        })
      : null;
    const port = {
      ...replayPort,
      ...reviewPort,
      run: (evalCase: ConversationQualityCase) =>
        evalCase.voiceTurn && voicePort ? voicePort.run(evalCase) : replayPort.run(evalCase),
    };

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

    // An uninitialized baseline can't gate — every case reads as "new" (informational),
    // so a run where all 12 cases fail would still exit 0. Fail loudly instead until a
    // baseline is recorded.
    if (!isBaselineInitialized(baseline)) {
      console.error(
        "Baseline is uninitialized — regression gating is disabled. Run `pnpm run evals:update-baseline` after a known-good run to enable it.",
      );
      process.exitCode = 1;
    }

    if (hasBaselineGateFailures(diff)) {
      console.error(
        `${diff.regressions.length + diff.rateRegressions.length + diff.judgeRegressions.length + diff.underSampled.length + diff.newCases.length + (diff.thresholdMismatch ? 1 : 0)} baseline gate failure(s).`,
      );
      process.exitCode = 1;
    }
  } finally {
    const shutdown = (deps as { shutdown?: () => Promise<void> }).shutdown;
    if (shutdown) {
      await shutdown.call(deps);
    }
  }
};

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
