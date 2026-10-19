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
 * `--channel voice` runs the voice cases (tests/fixtures/conversation-quality/voiceCases.ts) instead:
 * it turns voice on for the agent, seeds the corpus and the callback routine, publishes, serves
 * the composed app on a loopback port, and calls it as a voice runtime does, through the
 * `generic` dialect of the completions door with an `agent-api` credential, one streamed request
 * per caller turn. It gates on what the wire shows of each case's behaviour (a well-formed
 * stream, whether a bridge was spoken, the outcome) against voice-baseline.json, and reports each
 * case's latency (first byte, bridge, first speech, turn) without gating on it. A case whose
 * scenario needs a scripted brain's timing runs only in the deterministic half.
 *
 * The runner scores the deterministic layer and drops `llm_judge` assertions, except on cases
 * carrying a tag named with `--judge-tag` (repeatable): those are graded by the eval layer's
 * LLM judge on the cheapest text model the configuration resolves, the rerank tier, unless
 * `--judge-model` names another. Judging is opt-in per tag because each graded assertion is
 * one more model call per sample, and an ungated judge would make every nightly case pay it.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv, type Env } from "../src/app/config/env.js";
import { buildLlmRegistry } from "../src/app/server/builders/integrations.js";
import { createApp } from "../src/app/server/createApp.js";
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
  formatVoiceLatencyReport,
  hasBaselineGateFailures,
  isBaselineInitialized,
  mergeBaselineFile,
  parseConversationQualityCases,
  recordVoiceBaseline,
  runConversationQualitySuiteSampled,
  summarizeRun,
  summarizeVoiceCase,
  type BaselineFile,
  type ConversationQualityCase,
  type VoiceBaselineFile,
  type VoiceTurnObservation,
} from "../src/modules/eval/suite/index.js";
import type { OwnershipActor } from "../src/modules/handoff/public.js";
import { conversationQualityCases } from "../tests/fixtures/conversation-quality/cases.js";
import { conversationQualityCorpus } from "../tests/fixtures/conversation-quality/corpus.js";
import { conversationQualityDirectives } from "../tests/fixtures/conversation-quality/directives.js";
import { conversationQualityRoutines, CREATE_RETURN_TICKET_SKILL } from "../tests/fixtures/conversation-quality/routines.js";
import {
  conversationQualityVoiceCases,
  conversationQualityVoiceSettings,
  voiceCallbackRoutineDraft,
} from "../tests/fixtures/conversation-quality/voiceCases.js";
import { createReviewTurnRunnerPort, createWorkbenchReplayRunnerPort } from "./evalRunnerAdapter.js";
import { createVoiceCallRunnerPort, ownershipTeammate, voiceLineCatalog } from "./voiceEvalRunnerAdapter.js";

const BASELINE_PATH = fileURLToPath(
  new URL("../tests/fixtures/conversation-quality/baseline.json", import.meta.url),
);
const VOICE_BASELINE_PATH = fileURLToPath(
  new URL("../tests/fixtures/conversation-quality/voice-baseline.json", import.meta.url),
);

/** Which cases a run drives: the text turns, or the voice calls through the voice runtime's door. */
type EvalChannel = "text" | "voice";

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
  channel: EvalChannel;
}

const parseChannel = (value: string | undefined): EvalChannel => {
  if (value === "text" || value === "voice") return value;
  throw new Error(`--channel takes text or voice, not ${value ?? "nothing"}.`);
};

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

/** The workspace and agent a run seeds and drives, and the teammate a bootstrapped workspace registered. */
interface EvalTarget {
  workspaceId: string;
  agentId: string;
  teammate?: OwnershipActor;
}

/**
 * Resolves the workspace + agent to seed and run against. An explicit --workspace/--agent
 * (or RADIOSO_EVAL_* env) targets a specific disposable agent; otherwise a throwaway
 * account is registered so a fresh CI database is a one-liner. The agent is materialized
 * lazily via resolve().
 */
const ensureTarget = async (deps: Deps, flags: Flags): Promise<EvalTarget> => {
  if (flags.workspaceId && flags.agentId) {
    return { workspaceId: flags.workspaceId, agentId: flags.agentId };
  }
  const email = `eval-suite+${randomUUID()}@example.invalid`;
  const registration = await deps.authService.register({ email, password: `Ev@l-${randomUUID()}` });
  const agent = await deps.agentService.resolve(registration.workspaceId);
  console.log(`Bootstrapped disposable workspace ${registration.workspaceId} / agent ${agent.id}`);
  return {
    workspaceId: registration.workspaceId,
    agentId: agent.id,
    teammate: { accountId: registration.accountId, userId: registration.userId, workspaceId: registration.workspaceId },
  };
};

const loadBaseline = (): BaselineFile => {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Partial<BaselineFile>;
    return { generatedAt: parsed.generatedAt, passThreshold: parsed.passThreshold, cases: parsed.cases ?? {} };
  } catch {
    return { cases: {} };
  }
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
const seedCorpus = async (deps: Deps, flags: Flags): Promise<Map<string, string>> => {
  const documentIds = new Map<string, string>();
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
  return documentIds;
};

const seedFixtures = async (
  deps: Deps,
  flags: Flags,
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

/**
 * Fails the run when the baseline cannot gate or the diff holds a gate failure. An uninitialized
 * baseline can't gate: every case reads as "new", so a run where every case fails would still
 * exit 0. It fails loudly instead until a baseline is recorded.
 */
const gateOnBaseline = (baseline: BaselineFile, diff: ReturnType<typeof diffAgainstBaseline>, recordCommand: string): void => {
  if (!isBaselineInitialized(baseline)) {
    console.error(
      `Baseline is uninitialized — regression gating is disabled. Run \`${recordCommand}\` after a known-good run to enable it.`,
    );
    process.exitCode = 1;
  }
  if (hasBaselineGateFailures(diff)) {
    console.error(
      `${diff.regressions.length + diff.rateRegressions.length + diff.judgeRegressions.length + diff.underSampled.length + diff.newCases.length + (diff.thresholdMismatch ? 1 : 0)} baseline gate failure(s).`,
    );
    process.exitCode = 1;
  }
};

/** The voice assertions a live run gates on: the wire's view of the behaviour, never its wording or the turn's log. */
const LIVE_VOICE_ASSERTIONS = new Set<string>(["voice_turn_well_formed", "voice_bridge_spoken", "voice_outcome"]);

/**
 * The voice cases a live run drives, scored on what it gates. A case whose scenario is a brain
 * slower than the turn policy's deadlines runs only in the deterministic half, which scripts one.
 */
export const scopeVoiceCasesForLiveRun = (cases: readonly ConversationQualityCase[]): ConversationQualityCase[] =>
  cases
    .filter((evalCase) => evalCase.voice !== undefined && evalCase.voice.requiresScriptedTiming !== true)
    .map((evalCase) => ({
      ...evalCase,
      assertions: evalCase.assertions.filter((assertion) => LIVE_VOICE_ASSERTIONS.has(assertion.type)),
    }));

const loadVoiceBaseline = (): VoiceBaselineFile => {
  try {
    const parsed = JSON.parse(readFileSync(VOICE_BASELINE_PATH, "utf8")) as Partial<VoiceBaselineFile>;
    return { generatedAt: parsed.generatedAt, passThreshold: parsed.passThreshold, cases: parsed.cases ?? {}, latency: parsed.latency ?? {} };
  } catch {
    return { cases: {}, latency: {} };
  }
};

/** The teammate who acts on the voice cases' calls: the registered one, or the account's owner. */
const resolveTeammate = async (deps: Deps, target: EvalTarget): Promise<OwnershipActor> => {
  if (target.teammate) {
    return target.teammate;
  }
  const workspace = await deps.workspaceRepository.findById(target.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${target.workspaceId} not found.`);
  }
  const members = (await deps.accountAccessService.listAccountUsers(workspace.accountId)).filter((member) => member.status === "active");
  const teammate = members.find((member) => member.role === "owner") ?? members[0];
  if (!teammate) {
    throw new Error(`Account ${workspace.accountId} has no active member to act as the voice cases' teammate.`);
  }
  return { accountId: workspace.accountId, userId: teammate.userId, workspaceId: workspace.id };
};

/**
 * Gives the agent what the voice cases need, then publishes it, since a voice turn runs the
 * published agent: voice on with the fixture's lines, the corpus a knowledge question is answered
 * from, and the callback routine (once; a repeat run finds it by name).
 */
const prepareVoiceAgent = async (deps: Deps, flags: Flags): Promise<void> => {
  await waitForDocumentsReady(deps, flags.workspaceId, await seedCorpus(deps, flags));
  // The agent's vendor binding, if it has one, stays; the run only needs the lines and voice on.
  const agent = await deps.agentRepository.findByIdAndWorkspaceId(flags.agentId, flags.workspaceId);
  await deps.agentService.update(flags.workspaceId, flags.agentId, {
    voice: { ...conversationQualityVoiceSettings, runtime: agent?.voice.runtime ?? null },
  });
  const routines = await deps.routineDefinitionService.list(flags.workspaceId, flags.agentId);
  if (!routines.some((routine) => routine.name === voiceCallbackRoutineDraft.name && routine.enabled)) {
    await deps.routineDefinitionService.createDraft(flags.workspaceId, flags.agentId, voiceCallbackRoutineDraft);
  }
  await publishSeededAgent(deps, flags);
};

/** How long the voice runtime's credential lives, should the run die before it revokes it. */
const VOICE_CREDENTIAL_TTL_MS = 60 * 60_000;

/** Serves the composed app on a loopback port while `run` runs, as a voice runtime would reach it. */
const withServedApp = async <T>(deps: Deps, run: (origin: string) => Promise<T>): Promise<T> => {
  const server = createApp(deps).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

/**
 * Runs the voice cases live: each call through the `generic` dialect of the served app's
 * completions door with an `agent-api` credential, sampled like the text cases, gated on the wire
 * against voice-baseline.json, with each case's latency reported beside the gate.
 */
const runVoiceChannel = async (deps: Deps, flags: Flags, target: EvalTarget): Promise<void> => {
  const dataset = parseConversationQualityCases(conversationQualityVoiceCases);
  const cases = scopeVoiceCasesForLiveRun(filterByTags(dataset, flags.tags));
  console.log(`Preparing agent ${flags.agentId} for ${cases.length} voice case(s)…`);
  await prepareVoiceAgent(deps, flags);
  const teammate = ownershipTeammate(deps.conversationOwnershipService, await resolveTeammate(deps, target));
  const credential = await deps.accessGrantService.issueGrant({
    agentId: flags.agentId,
    workspaceId: flags.workspaceId,
    label: "Conversation-quality voice evals",
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + VOICE_CREDENTIAL_TTL_MS),
  });
  try {
    const observations = new Map<string, VoiceTurnObservation[]>();
    const { reports, outcomes } = await withServedApp(deps, (origin) => {
      const port = createVoiceCallRunnerPort({
        door: { origin, agentId: flags.agentId, token: credential.token },
        teammate,
        lines: voiceLineCatalog(conversationQualityVoiceSettings),
      });
      // Keeps every sample's observation for the latency section; the sampler keeps only scores.
      const voice = async (evalCase: ConversationQualityCase) => {
        const output = await port.voice!(evalCase);
        if (output.voiceTurn) {
          observations.set(evalCase.id, [...(observations.get(evalCase.id) ?? []), output.voiceTurn]);
        }
        return output;
      };
      if (flags.samples > 1) {
        console.log(`Sampling each voice case ${flags.samples}× (pass threshold ${flags.passThreshold})…`);
      }
      return runConversationQualitySuiteSampled(cases, { ...port, voice }, {
        workspaceId: flags.workspaceId,
        samples: flags.samples,
        passThreshold: flags.passThreshold,
        runIdPrefix: "cq-voice",
      });
    });

    const latencies = cases.map((evalCase) => summarizeVoiceCase(evalCase.id, observations.get(evalCase.id) ?? []));
    const baseline = loadVoiceBaseline();
    const diff = diffAgainstBaseline(outcomes, baseline, { passThreshold: flags.passThreshold });
    console.log(`\n${formatReport(reports, diff, summarizeRun(outcomes))}\n\n${formatVoiceLatencyReport(latencies, baseline.latency)}\n`);

    if (flags.updateBaseline) {
      if (flags.tags.length > 0 && baseline.passThreshold !== undefined && baseline.passThreshold !== flags.passThreshold) {
        throw new Error("A filtered baseline update cannot change the pass threshold; re-record every voice case at the new threshold.");
      }
      const recorded = recordVoiceBaseline({
        previous: baseline,
        outcomes,
        latencies,
        generatedAt: new Date().toISOString(),
        passThreshold: flags.passThreshold,
        filtered: flags.tags.length > 0,
      });
      writeFileSync(VOICE_BASELINE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
      console.log(`Baseline updated: ${path.relative(process.cwd(), VOICE_BASELINE_PATH)}`);
      return;
    }
    gateOnBaseline(baseline, diff, "pnpm run evals:voice:update-baseline");
  } finally {
    await deps.accessGrantService.revokeGrant({ grantId: credential.grant.id, reason: "voice evals finished" });
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
