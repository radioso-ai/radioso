/**
 * What the live conversation-quality run (`runEvals.ts`) decides and prepares, kept apart from the
 * CLI entry so the deterministic harness and the runner's tests use the same code: which cases a
 * live run gates and on what, the committed baseline file, the voice block a voice case needs, and
 * closing what the composition opened.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { closeDependencies, type ClosableDependencies } from "../src/app/server/closeDependencies.js";
import type { AgentVoiceSettings } from "../src/modules/agents/public.js";
import {
  isDeterministicOnlyAssertion,
  type BaselineFile,
  type ConversationQualityCase,
} from "../src/modules/eval/suite/index.js";
import { isMissingFile } from "../src/shared/infra/fileErrors.js";
import { CREATE_RETURN_TICKET_SKILL } from "../tests/fixtures/conversation-quality/routines.js";
import { VOICE_EVAL_LOCALE, voiceEvalVoiceLines } from "../tests/fixtures/voice-eval/agent.js";

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The account and agent calls `registerDisposableAgent` makes, narrowed so a test composition can serve them. */
interface DisposableAgentPorts {
  authService: { register(input: { email: string; password: string }): Promise<{ workspaceId: string }> };
  agentService: { resolve(workspaceId: string): Promise<{ id: string }> };
}

/**
 * Registers a throwaway account and materializes its workspace's default agent: the agent a run
 * seeds when no `--workspace`/`--agent` names one, and the one the deterministic voice harness
 * runs a scripted brain's case on.
 */
export const registerDisposableAgent = async (deps: DisposableAgentPorts): Promise<{ workspaceId: string; agentId: string }> => {
  const registration = await deps.authService.register({
    email: `eval-suite+${randomUUID()}@example.invalid`,
    password: `Ev@l-${randomUUID()}`,
  });
  const agent = await deps.agentService.resolve(registration.workspaceId);
  return { workspaceId: registration.workspaceId, agentId: agent.id };
};

/**
 * Reads the committed baseline. A missing file reads as an empty baseline, so the first recording
 * can create it and a run against it fails as uninitialized. A file that does not parse, or whose
 * top level or `cases` is no JSON object, throws, naming it: read as empty, it would gate nothing,
 * and a tag-filtered `--update-baseline` would write every other case's entry away.
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
  if (!isJsonObject(parsed)) {
    throw new Error(`The baseline at ${baselinePath} holds no JSON object; restore it from git before running.`);
  }
  const file = parsed as Partial<BaselineFile>;
  if (file.cases !== undefined && !isJsonObject(file.cases)) {
    throw new Error(`The baseline at ${baselinePath} holds \`cases\` that are no JSON object; restore it from git before running.`);
  }
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

/** A case whose every assertion is deterministic-only has nothing a live run can check. */
const isDeterministicOnlyCase = (evalCase: ConversationQualityCase): boolean =>
  evalCase.assertions.length > 0 && evalCase.assertions.every(isDeterministicOnlyAssertion);

/**
 * What a live run drives, and gates each case on. Takes cases as `parseConversationQualityCases`
 * returns them, so each voice assertion carries the scope its definition gives it
 * (`withDefinedVoiceScope`). A case whose every assertion is deterministic-only is skipped.
 * `llm_judge` assertions stay only on the cases `judgeTags` opts in (`scopeJudgeAssertions`), and
 * every voice case drops its deterministic-only assertions. A voice case left with nothing to gate
 * would pass whatever the agent did, so it is refused; the runner scopes before it opens a database
 * pool or registers an account, so a refused run costs nothing.
 */
export const scopeCasesForLiveRun = (
  cases: readonly ConversationQualityCase[],
  judgeTags: readonly string[],
): ConversationQualityCase[] =>
  scopeJudgeAssertions(cases.filter((evalCase) => !isDeterministicOnlyCase(evalCase)), judgeTags)
    .map((evalCase) => {
      if (!evalCase.voiceTurn) {
        return evalCase;
      }
      const assertions = evalCase.assertions.filter((assertion) => !isDeterministicOnlyAssertion(assertion));
      if (assertions.length === 0) {
        throw new Error(
          `Voice case "${evalCase.id}" gates nothing live once its deterministic-only assertions and ungraded judges are dropped; give it an assertion a live turn can check, or mark every assertion deterministicOnly.`,
        );
      }
      return { ...evalCase, assertions };
    });

/** Only a review case runs the published revision, so only a run that selects one publishes the agent. */
export const needsPublishedAgent = (cases: readonly ConversationQualityCase[]): boolean =>
  cases.some((evalCase) => evalCase.executionMode === "review");

/** Only a voice case drives the voice turn policy, so only a run that selects one turns voice on. */
export const needsVoiceSettings = (cases: readonly ConversationQualityCase[]): boolean =>
  cases.some((evalCase) => evalCase.voiceTurn !== undefined);

/** The agent reads and writes `seedVoiceSettings` makes, narrowed so a test can hand it fakes. */
interface VoiceSettingsSeedPorts {
  agents: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ voice: AgentVoiceSettings; assistantDefaultLocale: string | null } | null>;
  };
  agentSettings: { update(workspaceId: string, agentId: string, input: { voice: AgentVoiceSettings }): Promise<unknown> };
}

/**
 * Turns voice on for the seeded agent with the lines the voice cases need: a bridge line so a
 * case that searches has one to speak, and the fallback line `evalRunnerAdapter.ts`'s
 * `observeVoiceTurn` reads a turn's whole spoken text against to tell the turn limit apart from
 * a real answer (see `VOICE_EVAL_FALLBACK_LINE`). A case's call reports no language, so it speaks
 * the agent's default language, else English: the lines go in both. The block is written whole,
 * so they go over the agent's own: an agent `RADIOSO_EVAL_AGENT_ID` names keeps its runtime
 * binding, recording notice, language switching and its lines in every other language. No case
 * starts a vendor session, so none needs a runtime.
 */
export const seedVoiceSettings = async (
  ports: VoiceSettingsSeedPorts,
  target: { workspaceId: string; agentId: string },
): Promise<void> => {
  const agent = await ports.agents.findByIdAndWorkspaceId(target.agentId, target.workspaceId);
  if (!agent) {
    throw new Error(`Agent ${target.agentId} not found in workspace ${target.workspaceId}.`);
  }
  const lines = voiceEvalVoiceLines([...new Set([VOICE_EVAL_LOCALE, agent.assistantDefaultLocale ?? VOICE_EVAL_LOCALE])]);
  await ports.agentSettings.update(target.workspaceId, target.agentId, {
    voice: {
      ...agent.voice,
      enabled: lines.enabled,
      bridgeLines: { ...agent.voice.bridgeLines, ...lines.bridgeLines },
      fallbackLine: { ...agent.voice.fallbackLine, ...lines.fallbackLine },
    },
  });
};

/**
 * The skills the seeded routines dispatch. Publishing refuses a routine whose tool step names a
 * skill the agent lacks, so the agent holds these skills while it is published.
 */
export const seededRoutineSkillNames: readonly string[] = [CREATE_RETURN_TICKET_SKILL];

/**
 * Closes what the composition opened, as the API runtime does (`closeDependencies`), then ends the
 * database pool, each even when a step before it fails, so the process exits once the run is done.
 */
export const closeEvalDependencies = async (
  deps: ClosableDependencies & { connectorDb: { close(): Promise<void> } },
): Promise<void> => {
  try {
    await closeDependencies(deps);
  } finally {
    await deps.connectorDb.close();
  }
};
