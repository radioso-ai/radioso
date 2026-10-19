/**
 * The voice channel of the conversation-quality runner (`runEvals.ts --channel voice`): it turns
 * voice on for the agent, seeds the corpus and the callback routine, publishes, serves the composed
 * app on a loopback port, and calls it as a voice runtime does through the `generic` dialect of the
 * completions door with an `agent-api` credential it revokes at the end. It gates on what the wire
 * shows of each case's behaviour against voice-baseline.json, and reports each case's latency
 * without gating on it.
 */
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app/server/createApp.js";
import {
  diffAgainstBaseline,
  formatReport,
  formatVoiceLatencyReport,
  parseConversationQualityCases,
  recordVoiceBaseline,
  runConversationQualitySuiteSampled,
  scopeVoiceCasesForLiveRun,
  summarizeRun,
  summarizeVoiceCase,
  unrecordedLatencyNotice,
  type ConversationQualityCase,
  type VoiceBaselineFile,
  type VoiceCaseSample,
} from "../src/modules/eval/suite/index.js";
import type { OwnershipActor } from "../src/modules/handoff/public.js";
import { VoiceSessionRepository } from "../src/modules/voiceChannel/public.js";
import {
  conversationQualityVoiceCases,
  conversationQualityVoiceSettings,
  voiceCallbackRoutineDraft,
} from "../tests/fixtures/conversation-quality/voiceCases.js";
import {
  filterByTags,
  gateOnBaseline,
  loadBaselineFile,
  publishAgent,
  seedCorpus,
  waitForDocumentsReady,
  type EvalDeps,
  type EvalRunFlags,
  type EvalTarget,
} from "./evalRunSupport.js";
import { createVoiceCallRunnerPort, ownershipTeammate, voiceLineCatalog } from "./voiceEvalRunnerAdapter.js";

const VOICE_BASELINE_PATH = fileURLToPath(
  new URL("../tests/fixtures/conversation-quality/voice-baseline.json", import.meta.url),
);

const loadVoiceBaseline = (): VoiceBaselineFile => {
  const { latency, ...baseline } = loadBaselineFile(VOICE_BASELINE_PATH);
  return { ...baseline, latency: latency ?? {} };
};

/**
 * Adds the voice latency section to the GitHub Actions step summary when the run is a workflow
 * step, with the missing-baseline notice as a warning annotation the run page shows.
 */
const writeStepSummary = (latencyReport: string, notice: string | null): void => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  appendFileSync(summaryPath, `## Voice cases\n\n${notice ? `> ${notice}\n\n` : ""}\`\`\`text\n${latencyReport}\n\`\`\`\n`);
  if (notice) {
    console.log(`::warning title=Voice latency baseline::${notice}`);
  }
};

/** The teammate who acts on the voice cases' calls: the registered one, or the account's owner. */
const resolveTeammate = async (deps: EvalDeps, target: EvalTarget): Promise<OwnershipActor> => {
  if (target.teammate) {
    return target.teammate;
  }
  const workspace = await deps.workspaceRepository.findById(target.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${target.workspaceId} not found.`);
  }
  // The service lists the account's active members.
  const members = await deps.accountAccessService.listAccountUsers(workspace.accountId);
  const teammate = members.find((member) => member.role === "owner") ?? members[0];
  if (!teammate) {
    throw new Error(`Account ${workspace.accountId} has no active member to act as the voice cases' teammate.`);
  }
  return { accountId: workspace.accountId, userId: teammate.userId, workspaceId: workspace.id };
};

/**
 * Gives the agent what the voice cases need, then publishes it, since a voice turn runs the
 * published agent: voice on with the fixture's lines over whatever else its voice block holds, the
 * corpus a knowledge question is answered from, and the callback routine, found by name and turned
 * back on when a run before left it off.
 */
const prepareVoiceAgent = async (deps: EvalDeps, flags: EvalRunFlags): Promise<void> => {
  await waitForDocumentsReady(deps, flags.workspaceId, await seedCorpus(deps, flags));
  const agent = await deps.agentRepository.findByIdAndWorkspaceId(flags.agentId, flags.workspaceId);
  if (!agent) {
    throw new Error(`Agent ${flags.agentId} not found in workspace ${flags.workspaceId}.`);
  }
  await deps.agentService.update(flags.workspaceId, flags.agentId, { voice: { ...agent.voice, ...conversationQualityVoiceSettings } });
  const callback = (await deps.routineDefinitionService.list(flags.workspaceId, flags.agentId))
    .find((routine) => routine.name === voiceCallbackRoutineDraft.name);
  if (!callback) {
    await deps.routineDefinitionService.createDraft(flags.workspaceId, flags.agentId, voiceCallbackRoutineDraft);
  } else if (!callback.enabled) {
    await deps.routineDefinitionService.setEnabled(flags.workspaceId, flags.agentId, callback.id, true);
  }
  // The callback routine dispatches no skill, so the agent publishes without the text suite's skills.
  await publishAgent(deps, flags);
};

/** How long the voice runtime's credential lives, should the run die before it revokes it. */
const VOICE_CREDENTIAL_TTL_MS = 60 * 60_000;

/** Serves the composed app on a loopback port while `run` runs, as a voice runtime would reach it. */
const withServedApp = async <T>(deps: EvalDeps, run: (origin: string) => Promise<T>): Promise<T> => {
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
export const runVoiceChannel = async (deps: EvalDeps, flags: EvalRunFlags, target: EvalTarget): Promise<void> => {
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
    const samples = new Map<string, VoiceCaseSample[]>();
    const keep = (caseId: string, sample: VoiceCaseSample): void => {
      samples.set(caseId, [...(samples.get(caseId) ?? []), sample]);
    };
    const { reports, outcomes } = await withServedApp(deps, (origin) => {
      const sessions = new VoiceSessionRepository(deps.connectorDb.kysely);
      const port = createVoiceCallRunnerPort({
        door: { origin, agentId: flags.agentId, token: credential.token },
        teammate,
        conversations: {
          conversationOf: (sessionKey) =>
            sessions.findConversationId({ workspaceId: flags.workspaceId, agentId: flags.agentId, vendor: "generic", sessionKey }),
        },
        lines: voiceLineCatalog(conversationQualityVoiceSettings),
      });
      // Keeps every sample for the latency section, an errored one included; the sampler keeps only scores.
      const voice = async (evalCase: ConversationQualityCase) => {
        try {
          const output = await port.voice!(evalCase);
          keep(evalCase.id, output.voiceTurn ?? { error: output.error?.message ?? "The runner observed no voice turn." });
          return output;
        } catch (error) {
          keep(evalCase.id, { error: error instanceof Error ? error.message : "The runner threw a non-Error value." });
          throw error;
        }
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

    const latencies = cases.map((evalCase) => summarizeVoiceCase(evalCase.id, samples.get(evalCase.id) ?? []));
    const baseline = loadVoiceBaseline();
    const diff = diffAgainstBaseline(outcomes, baseline, { passThreshold: flags.passThreshold });
    const latencyReport = formatVoiceLatencyReport(latencies, baseline.latency);
    console.log(`\n${formatReport(reports, diff, summarizeRun(outcomes))}\n\n${latencyReport}\n`);
    writeStepSummary(latencyReport, unrecordedLatencyNotice(latencies, baseline.latency));

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
