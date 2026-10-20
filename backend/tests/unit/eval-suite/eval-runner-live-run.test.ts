import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentVoiceSettings } from "../../../src/modules/agents/public.js";
import { parseConversationQualityCases, type ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/cases.js";
import { VOICE_EVAL_VOICE_SETTINGS } from "../../fixtures/voice-eval/agent.js";
import { voiceEvalCases } from "../../fixtures/voice-eval/cases.js";
import {
  closeEvalDependencies,
  loadBaseline,
  scopeCasesForLiveRun,
  scopeJudgeAssertions,
  seedVoiceSettings,
} from "../../../scripts/evalRunnerSupport.js";

const voiceCase = (overrides: Partial<ConversationQualityCase>): ConversationQualityCase => ({
  id: "voice-scope-case",
  name: "A voice case",
  tags: ["voice"],
  query: "Hello there",
  voiceTurn: { chatEvents: [{ type: "done" }] },
  assertions: [],
  ...overrides,
});

describe("live runner scope", () => {
  it("never gates a live voice case on latency: drops \"no bridge\" and \"the limit fired\"", () => {
    const [scoped] = scopeCasesForLiveRun([voiceCase({
      assertions: [
        { type: "voice_bridge_emitted", expected: false },
        { type: "voice_turn_limit_reached", expected: true },
        { type: "voice_turn_outcome", kind: "continue" },
      ],
    })], []);

    expect(scoped?.assertions).toEqual([{ type: "voice_turn_outcome", kind: "continue" }]);
  });

  it("keeps the voice expectations a slow brain cannot break: a bridge, and a turn that never reached its limit", () => {
    const [scoped] = scopeCasesForLiveRun([voiceCase({
      assertions: [
        { type: "voice_bridge_emitted", expected: true },
        { type: "voice_turn_limit_reached", expected: false },
      ],
    })], []);

    expect(scoped?.assertions).toEqual([
      { type: "voice_bridge_emitted", expected: true },
      { type: "voice_turn_limit_reached", expected: false },
    ]);
  });

  it("skips a deterministic-only voice case", () => {
    const scoped = scopeCasesForLiveRun([
      voiceCase({ id: "runs-live", assertions: [{ type: "voice_turn_outcome", kind: "continue" }] }),
      voiceCase({
        id: "scripted-only",
        voiceTurn: { chatEvents: [{ type: "stall" }], deterministicOnly: true },
        assertions: [{ type: "voice_turn_limit_reached", expected: true }],
      }),
    ], []);

    expect(scoped.map((evalCase) => evalCase.id)).toEqual(["runs-live"]);
  });

  it("refuses a live voice case left with nothing to gate", () => {
    expect(() => scopeCasesForLiveRun([voiceCase({
      id: "gates-nothing",
      assertions: [{ type: "voice_bridge_emitted", expected: false }],
    })], [])).toThrow(/"gates-nothing".*deterministicOnly/u);
  });

  it("refuses a live voice case whose only gate is a judge the run does not grade, and keeps it when the run grades it", () => {
    const judgedOnly = voiceCase({
      id: "judged-only",
      tags: ["voice", "voice-wording"],
      assertions: [{ type: "llm_judge", expectedAnswer: "The reply thanks the caller." }],
    });

    expect(() => scopeCasesForLiveRun([judgedOnly], [])).toThrow(/"judged-only"/u);
    expect(scopeCasesForLiveRun([judgedOnly], ["voice-wording"])).toEqual([judgedOnly]);
  });

  it("scopes text cases by judge tag alone", () => {
    const committed = parseConversationQualityCases(conversationQualityCases);

    expect(scopeCasesForLiveRun(committed, ["quick-reply"])).toEqual(scopeJudgeAssertions(committed, ["quick-reply"]));
  });

  it("runs the committed voice cases live on behaviour alone, without the deterministic-only cases", () => {
    const scoped = scopeCasesForLiveRun(parseConversationQualityCases(voiceEvalCases), []);

    expect(Object.fromEntries(scoped.map((evalCase) => [evalCase.id, evalCase.assertions]))).toEqual({
      "voice-bridge-on-searching": [
        { type: "voice_bridge_emitted", expected: true },
        { type: "voice_turn_outcome", kind: "continue" },
      ],
      "voice-outcome-handoff": [{ type: "voice_turn_outcome", kind: "callback_requested" }],
    });
  });

  it("holds a committed baseline entry for every voice case a live run drives, and none for a deterministic-only one", () => {
    const baseline = JSON.parse(
      readFileSync(new URL("../../fixtures/conversation-quality/baseline.json", import.meta.url), "utf8"),
    ) as { cases: Record<string, unknown> };
    const recordedVoiceCases = Object.keys(baseline.cases).filter((caseId) => voiceEvalCases.some((evalCase) => evalCase.id === caseId));

    expect(recordedVoiceCases.sort()).toEqual(
      scopeCasesForLiveRun(parseConversationQualityCases(voiceEvalCases), []).map((evalCase) => evalCase.id).sort(),
    );
  });
});

describe("live runner baseline file", () => {
  let directory: string | undefined;
  const baselineAt = (contents?: string): string => {
    directory = mkdtempSync(path.join(tmpdir(), "cq-baseline-"));
    const baselinePath = path.join(directory, "baseline.json");
    if (contents !== undefined) {
      writeFileSync(baselinePath, contents);
    }
    return baselinePath;
  };
  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("reads a committed baseline", () => {
    const baselinePath = baselineAt(JSON.stringify({
      generatedAt: "2026-10-20T00:00:00.000Z",
      passThreshold: 1,
      cases: { "greeting-en": { status: "pass", passRate: 1, samples: 5 } },
    }));

    expect(loadBaseline(baselinePath)).toEqual({
      generatedAt: "2026-10-20T00:00:00.000Z",
      passThreshold: 1,
      cases: { "greeting-en": { status: "pass", passRate: 1, samples: 5 } },
    });
  });

  it("reads a missing baseline as an empty one, so a first recording can create it", () => {
    expect(loadBaseline(baselineAt())).toEqual({ cases: {} });
  });

  it("throws on a damaged baseline, naming it, so a recording run never writes every other case away", () => {
    const baselinePath = baselineAt('{ "cases": { "greeting-en": ');

    expect(() => loadBaseline(baselinePath)).toThrow(baselinePath);
  });

  it("throws on a baseline that holds no JSON object", () => {
    const baselinePath = baselineAt("[]");

    expect(() => loadBaseline(baselinePath)).toThrow(baselinePath);
  });
});

describe("live runner agent preparation", () => {
  const target = { workspaceId: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222" };

  it("writes the voice cases' lines over the agent's own voice block, keeping its runtime, recording notice and language switching", async () => {
    const operatorVoice: AgentVoiceSettings = {
      enabled: false,
      bridgeLines: { it: { acknowledge: [], check: ["Un attimo, controllo subito."] } },
      fallbackLine: { it: "Scusa, ci sto mettendo troppo." },
      recordingNotice: { en: "This call is recorded." },
      runtime: { vendor: "elevenlabs", agentId: "agent_operator_bound", region: "eu" },
      languageSwitching: true,
    };
    const update = vi.fn(async () => undefined);

    await seedVoiceSettings({
      agents: { findByIdAndWorkspaceId: async () => ({ voice: operatorVoice }) },
      agentSettings: { update },
    }, target);

    expect(update).toHaveBeenCalledExactlyOnceWith(target.workspaceId, target.agentId, {
      voice: {
        ...VOICE_EVAL_VOICE_SETTINGS,
        recordingNotice: { en: "This call is recorded." },
        runtime: { vendor: "elevenlabs", agentId: "agent_operator_bound", region: "eu" },
        languageSwitching: true,
      },
    });
  });

  it("refuses an agent it cannot find rather than writing a voice block onto nothing", async () => {
    const update = vi.fn(async () => undefined);

    await expect(seedVoiceSettings({
      agents: { findByIdAndWorkspaceId: async () => null },
      agentSettings: { update },
    }, target)).rejects.toThrow(target.agentId);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("live runner shutdown", () => {
  it("closes the approval journal and the abuse-control repository, then ends the pool", async () => {
    const closed: string[] = [];

    await closeEvalDependencies({
      closeApprovalResumeEffectJournal: async () => { closed.push("approval journal"); },
      closeAbuseControlRepository: async () => { closed.push("abuse control"); },
      connectorDb: { close: async () => { closed.push("pool"); } },
    });

    expect(closed).toEqual(["approval journal", "abuse control", "pool"]);
  });

  it("still ends the pool when a closer before it fails, and reports that failure", async () => {
    const close = vi.fn(async () => undefined);

    await expect(closeEvalDependencies({
      closeApprovalResumeEffectJournal: async () => { throw new Error("journal close failed"); },
      connectorDb: { close },
    })).rejects.toThrow("journal close failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
