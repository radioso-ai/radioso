/**
 * What the live conversation-quality run (`runEvals.ts`) decides and prepares, kept apart from the
 * CLI entry so the deterministic harness and the runner's tests use the same code: which cases a
 * live run gates and on what, the committed baseline file, the voice block a voice case needs, and
 * closing what the composition opened.
 */
import { readFileSync } from "node:fs";

import type { AgentVoiceSettings } from "../src/modules/agents/public.js";
import type { BaselineFile, ConversationQualityCase } from "../src/modules/eval/suite/index.js";
import { CREATE_RETURN_TICKET_SKILL } from "../tests/fixtures/conversation-quality/routines.js";
import { VOICE_EVAL_VOICE_SETTINGS } from "../tests/fixtures/voice-eval/agent.js";

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

/** Only a review case runs the published revision, so only a run that selects one publishes the agent. */
export const needsPublishedAgent = (cases: readonly ConversationQualityCase[]): boolean =>
  cases.some((evalCase) => evalCase.executionMode === "review");

/** Only a voice case drives the voice turn policy, so only a run that selects one turns voice on. */
export const needsVoiceSettings = (cases: readonly ConversationQualityCase[]): boolean =>
  cases.some((evalCase) => evalCase.voiceTurn !== undefined);

/** The agent reads and writes `seedVoiceSettings` makes, narrowed so a test can hand it fakes. */
interface VoiceSettingsSeedPorts {
  agents: { findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ voice: AgentVoiceSettings } | null> };
  agentSettings: { update(workspaceId: string, agentId: string, input: { voice: AgentVoiceSettings }): Promise<unknown> };
}

/**
 * Turns voice on for the seeded agent with the lines the voice cases need: a bridge line so a
 * case that searches has one to speak, and the fallback line `evalRunnerAdapter.ts`'s
 * `observeVoiceTurn` reads a turn's whole spoken text against to tell the turn limit apart from
 * a real answer (see `VOICE_EVAL_FALLBACK_LINE`). The block is written whole, so the lines go
 * over the agent's own: an agent `RADIOSO_EVAL_AGENT_ID` names keeps its runtime binding,
 * recording notice and language switching. No case starts a vendor session, so none needs a
 * runtime.
 */
export const seedVoiceSettings = async (
  ports: VoiceSettingsSeedPorts,
  target: { workspaceId: string; agentId: string },
): Promise<void> => {
  const agent = await ports.agents.findByIdAndWorkspaceId(target.agentId, target.workspaceId);
  if (!agent) {
    throw new Error(`Agent ${target.agentId} not found in workspace ${target.workspaceId}.`);
  }
  await ports.agentSettings.update(target.workspaceId, target.agentId, {
    voice: { ...agent.voice, ...VOICE_EVAL_VOICE_SETTINGS },
  });
};

/**
 * The skills the seeded routines dispatch. Publishing refuses a routine whose tool step names a
 * skill the agent lacks, so the agent holds these skills while it is published.
 */
export const seededRoutineSkillNames: readonly string[] = [CREATE_RETURN_TICKET_SKILL];

/** What the composition holds open that a finished run must close, the database pool last. */
interface EvalDependencyClosers {
  closeApprovalResumeEffectJournal(): Promise<void>;
  closeAbuseControlRepository?(): Promise<void>;
  connectorDb: { close(): Promise<void> };
}

/**
 * Closes the approval journal's database, then the abuse-control repository, then ends the pool,
 * each even when one before it fails, so the process can exit once the run is done.
 */
export const closeEvalDependencies = async (deps: EvalDependencyClosers): Promise<void> => {
  try {
    await deps.closeApprovalResumeEffectJournal();
  } finally {
    try {
      await deps.closeAbuseControlRepository?.();
    } finally {
      await deps.connectorDb.close();
    }
  }
};
