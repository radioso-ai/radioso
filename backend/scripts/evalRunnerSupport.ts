/**
 * What the live conversation-quality run (`runEvals.ts`) decides and prepares, kept apart from the
 * CLI entry so the deterministic harness and the runner's tests use the same code: which cases a
 * live run gates and on what, the committed baseline file, the voice block a voice case needs, and
 * closing what the composition opened.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { closeInOrder, dependencyCloseSteps, type ClosableDependencies } from "../src/app/server/closeDependencies.js";
import type { AppDependencies } from "../src/app/server/types.js";
import { agentVoiceSettingsInputSchema, type AgentVoiceSettings } from "../src/modules/agents/public.js";
import {
  isDeterministicOnlyAssertion,
  parseBaselineFile,
  type BaselineFile,
  type ConversationQualityCase,
} from "../src/modules/eval/suite/index.js";
import { isMissingFile } from "../src/shared/infra/fileErrors.js";
import { CREATE_RETURN_TICKET_SKILL } from "../tests/fixtures/conversation-quality/routines.js";
import { VOICE_EVAL_LOCALE, voiceEvalVoiceLines } from "../tests/fixtures/voice-eval/agent.js";

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
 * can create it and a run against it fails as uninitialized. A file that cannot be read, does not
 * parse, or does not fit the shape the recorder writes (`parseBaselineFile`) throws, naming it:
 * read as empty, it would gate nothing, and a tag-filtered `--update-baseline` would write every
 * other case's entry away.
 */
export const loadBaseline = (baselinePath: string): BaselineFile => {
  let text: string;
  try {
    text = readFileSync(baselinePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { cases: {} };
    }
    throw new Error(`The baseline at ${baselinePath} cannot be read: ${(error as Error).message}`, { cause: error });
  }
  try {
    return parseBaselineFile(JSON.parse(text));
  } catch (error) {
    throw new Error(
      `The baseline at ${baselinePath} is no baseline file (${(error as Error).message}); restore it from git before running.`,
      { cause: error },
    );
  }
};

/**
 * The baseline a run compares against. A gating run and a tag-filtered recording both read it,
 * the second to merge into it, so a file `loadBaseline` refuses stops them. A full recording
 * rewrites the file whole, so over a file it cannot read it warns and compares against an empty
 * baseline instead.
 */
export const readRunBaseline = (
  baselinePath: string,
  run: { updateBaseline: boolean; tags: readonly string[] },
  warn: (message: string) => void,
): BaselineFile => {
  if (!run.updateBaseline || run.tags.length > 0) {
    return loadBaseline(baselinePath);
  }
  try {
    return loadBaseline(baselinePath);
  } catch (error) {
    warn(`${(error as Error).message} A full recording rewrites it, so this run compares against an empty baseline.`);
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

/** A seeded voice block, and how to put the agent's own back. */
interface SeededVoiceSettings {
  restore(): Promise<void>;
}

/**
 * Turns voice on for the seeded agent with the lines the voice cases need: a bridge line so a
 * case that searches has one to speak, and the fallback line `evalRunnerAdapter.ts`'s
 * `observeVoiceTurn` reads a turn's whole spoken text against to tell the turn limit apart from
 * a real answer (see `VOICE_EVAL_FALLBACK_LINE`). A case's call reports no language, so it speaks
 * the agent's default language, else English: the lines go in both, merged into the agent's own
 * lines, and its recording notice and language switching stay.
 *
 * The run binds no vendor runtime: the voice turn port never starts a vendor session, and a
 * session start needs one, so an agent the run turns voice on for is never callable, even when a
 * restore fails. `restore` writes a named agent's own block back, runtime binding included, once
 * the run is done; a disposable agent's block stays as the run left it. The merged block is
 * checked as a write is before anything is written, so an agent that cannot take the lines (one
 * with lines in the most languages a block holds) is refused by name.
 */
export const seedVoiceSettings = async (
  ports: VoiceSettingsSeedPorts,
  target: { workspaceId: string; agentId: string; disposable: boolean },
): Promise<SeededVoiceSettings> => {
  const agent = await ports.agents.findByIdAndWorkspaceId(target.agentId, target.workspaceId);
  if (!agent) {
    throw new Error(`Agent ${target.agentId} not found in workspace ${target.workspaceId}.`);
  }
  const ownVoice = agent.voice;
  const lines = voiceEvalVoiceLines([...new Set([VOICE_EVAL_LOCALE, agent.assistantDefaultLocale ?? VOICE_EVAL_LOCALE])]);
  const seeded: AgentVoiceSettings = {
    ...ownVoice,
    enabled: lines.enabled,
    runtime: null,
    bridgeLines: { ...ownVoice.bridgeLines, ...lines.bridgeLines },
    fallbackLine: { ...ownVoice.fallbackLine, ...lines.fallbackLine },
  };
  const check = agentVoiceSettingsInputSchema.safeParse(seeded);
  if (!check.success) {
    const problems = check.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Agent ${target.agentId} cannot take the voice cases' lines (${problems}); point the run at another agent.`);
  }
  await ports.agentSettings.update(target.workspaceId, target.agentId, { voice: seeded });
  return {
    restore: async () => {
      if (!target.disposable) {
        await ports.agentSettings.update(target.workspaceId, target.agentId, { voice: ownVoice });
      }
    },
  };
};

/**
 * Refuses a run that would publish over the revision a named agent serves. Publishing the seeded
 * routines, directives and corpus makes them the agent's live behaviour, and the runner has no
 * clean way to put the previous revision back, so a named agent with a published revision is
 * refused unless the run is told to accept that (`--allow-named-agent-republish`). A disposable
 * agent, an agent with nothing published, and a run that publishes nothing go on.
 */
export const assertNamedAgentMayBePublished = async (
  ports: { revisions: { state(workspaceId: string, agentId: string): Promise<{ publishedRevision: { id: string } | null }> } },
  target: { workspaceId: string; agentId: string; disposable: boolean },
  run: { publishes: boolean; allowRepublish: boolean },
): Promise<void> => {
  if (target.disposable || !run.publishes || run.allowRepublish) {
    return;
  }
  const { publishedRevision } = await ports.revisions.state(target.workspaceId, target.agentId);
  if (publishedRevision) {
    throw new Error(
      `Agent ${target.agentId} serves published revision ${publishedRevision.id}, and this run would publish the seeded fixtures over it; point the run at a disposable agent, or pass --allow-named-agent-republish to accept that.`,
    );
  }
};

/**
 * The skills the seeded routines dispatch. Publishing refuses a routine whose tool step names a
 * skill the agent lacks, so the agent holds these skills while it is published.
 */
export const seededRoutineSkillNames: readonly string[] = [CREATE_RETURN_TICKET_SKILL];

/**
 * Closes what the composition opened, as every runtime does (`dependencyCloseSteps`), then ends
 * the database pool, each step even after one before it fails, so the process exits once the run
 * is done.
 */
export const closeEvalDependencies = (
  deps: ClosableDependencies & Pick<AppDependencies, "connectorDb">,
): Promise<void> =>
  closeInOrder(
    [...dependencyCloseSteps(deps), { name: "database pool", close: () => deps.connectorDb.close() }],
    deps.logger,
  );

/**
 * Runs `run`, then `close`, whatever `run` did. A failure to close goes to `reportCloseFailure`
 * and is never thrown, so it cannot take the place of the run's own error or of its result.
 */
export const runThenClose = async <T>(
  run: () => Promise<T>,
  close: () => Promise<void>,
  reportCloseFailure: (error: unknown) => void,
): Promise<T> => {
  try {
    return await run();
  } finally {
    try {
      await close();
    } catch (error) {
      reportCloseFailure(error);
    }
  }
};
