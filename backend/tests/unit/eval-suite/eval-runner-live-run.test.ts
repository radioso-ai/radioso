import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentVoiceSettings } from "../../../src/modules/agents/public.js";
import { parseConversationQualityCases, type ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/cases.js";
import { VOICE_EVAL_BRIDGE_LINES, VOICE_EVAL_FALLBACK_LINE } from "../../fixtures/voice-eval/agent.js";
import { voiceEvalCases } from "../../fixtures/voice-eval/cases.js";
import {
  closeEvalDependencies,
  loadBaseline,
  runThenClose,
  scopeCasesForLiveRun,
  scopeJudgeAssertions,
  seedVoiceSettings,
} from "../../../scripts/evalRunnerSupport.js";

/** A voice case as a run reads it: parsed, so its assertions carry the scope their definitions give them. */
const voiceCase = (overrides: Partial<ConversationQualityCase>): ConversationQualityCase =>
  parseConversationQualityCases([{
    id: "voice-scope-case",
    name: "A voice case",
    tags: ["voice"],
    query: "Hello there",
    voiceTurn: { chatEvents: [{ type: "done" }] },
    assertions: [],
    ...overrides,
  }])[0];

describe("live runner scope", () => {
  it("never gates a live voice case on latency: drops whether it bridged when it should not have, and the turn limit either way", () => {
    const [scoped] = scopeCasesForLiveRun([voiceCase({
      assertions: [
        { type: "voice_bridge_emitted", expected: false },
        { type: "voice_turn_limit_reached", expected: true },
        { type: "voice_turn_limit_reached", expected: false },
        { type: "voice_turn_outcome", kind: "continue" },
      ],
    })], []);

    expect(scoped?.assertions).toEqual([{ type: "voice_turn_outcome", kind: "continue" }]);
  });

  it("gates a live voice case on a spoken bridge and on its outcome", () => {
    const [scoped] = scopeCasesForLiveRun([voiceCase({
      assertions: [
        { type: "voice_bridge_emitted", expected: true },
        { type: "voice_turn_outcome", kind: "callback_requested" },
      ],
    })], []);

    expect(scoped?.assertions).toEqual([
      { type: "voice_bridge_emitted", expected: true },
      { type: "voice_turn_outcome", kind: "callback_requested" },
    ]);
  });

  it("skips a case whose every assertion is deterministic-only", () => {
    const scoped = scopeCasesForLiveRun([
      voiceCase({ id: "runs-live", assertions: [{ type: "voice_turn_outcome", kind: "continue" }] }),
      voiceCase({
        id: "scripted-only",
        assertions: [
          { type: "voice_bridge_emitted", expected: false },
          { type: "voice_turn_outcome", kind: "continue", deterministicOnly: true },
        ],
      }),
    ], []);

    expect(scoped.map((evalCase) => evalCase.id)).toEqual(["runs-live"]);
  });

  it("refuses a live voice case left with nothing to gate", () => {
    expect(() => scopeCasesForLiveRun([voiceCase({ id: "gates-nothing" })], [])).toThrow(/"gates-nothing"/u);
  });

  it("refuses a live voice case whose only live gate is a judge the run does not grade, and keeps it when the run grades it", () => {
    const judgedOnly = voiceCase({
      id: "judged-only",
      tags: ["voice", "voice-wording"],
      assertions: [
        { type: "voice_bridge_emitted", expected: false },
        { type: "llm_judge", expectedAnswer: "The reply thanks the caller." },
      ],
    });

    expect(() => scopeCasesForLiveRun([judgedOnly], [])).toThrow(/"judged-only"/u);
    expect(scopeCasesForLiveRun([judgedOnly], ["voice-wording"])[0]?.assertions)
      .toEqual([{ type: "llm_judge", expectedAnswer: "The reply thanks the caller." }]);
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

  it.each([
    ["an array", "[]"],
    ["a string", '"greeting-en"'],
    ["null", "null"],
  ])("throws on a baseline whose cases are %s", (_shape, cases) => {
    const baselinePath = baselineAt(`{ "passThreshold": 1, "cases": ${cases} }`);

    expect(() => loadBaseline(baselinePath)).toThrow(baselinePath);
  });
});

describe("live runner agent preparation", () => {
  const named = { workspaceId: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222", disposable: false };
  const evalLines = { bridge: VOICE_EVAL_BRIDGE_LINES, fallback: VOICE_EVAL_FALLBACK_LINE };
  const operatorVoice: AgentVoiceSettings = {
    enabled: false,
    bridgeLines: { de: { acknowledge: [], check: ["Einen Moment, ich schaue nach."] } },
    fallbackLine: { de: "Entschuldigung, das dauert zu lange." },
    recordingNotice: { en: "This call is recorded." },
    runtime: { vendor: "elevenlabs", agentId: "agent_operator_bound", region: "eu" },
    languageSwitching: true,
  };
  const seedOnto = async (
    agent: { voice: AgentVoiceSettings; assistantDefaultLocale: string | null },
    target: { workspaceId: string; agentId: string; disposable: boolean } = named,
  ) => {
    const update = vi.fn(async () => undefined);
    const seeded = await seedVoiceSettings({ agents: { findByIdAndWorkspaceId: async () => agent }, agentSettings: { update } }, target);
    return { update, seeded };
  };

  it("writes the voice cases' lines over the agent's own voice block, keeping its runtime, recording notice, language switching and other lines", async () => {
    const { update } = await seedOnto({ voice: operatorVoice, assistantDefaultLocale: null });

    expect(update).toHaveBeenCalledExactlyOnceWith(named.workspaceId, named.agentId, {
      voice: {
        ...operatorVoice,
        enabled: true,
        bridgeLines: { ...operatorVoice.bridgeLines, en: evalLines.bridge },
        fallbackLine: { ...operatorVoice.fallbackLine, en: evalLines.fallback },
      },
    });
  });

  it("writes the lines in the agent's default language too, which a call with no language of its own speaks in", async () => {
    const { update } = await seedOnto({ voice: operatorVoice, assistantDefaultLocale: "it-IT" });

    expect(update).toHaveBeenCalledExactlyOnceWith(named.workspaceId, named.agentId, {
      voice: expect.objectContaining({
        bridgeLines: { ...operatorVoice.bridgeLines, en: evalLines.bridge, "it-IT": evalLines.bridge },
        fallbackLine: { ...operatorVoice.fallbackLine, en: evalLines.fallback, "it-IT": evalLines.fallback },
      }),
    });
  });

  it("puts a named agent's voice block back as it was once the run is done", async () => {
    const { update, seeded } = await seedOnto({ voice: operatorVoice, assistantDefaultLocale: null });

    await seeded.restore();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(named.workspaceId, named.agentId, { voice: operatorVoice });
  });

  it("leaves a disposable agent's voice block as the run left it", async () => {
    const { update, seeded } = await seedOnto({ voice: operatorVoice, assistantDefaultLocale: null }, { ...named, disposable: true });

    await seeded.restore();

    expect(update).toHaveBeenCalledOnce();
  });

  it("refuses, naming the agent, a voice block that cannot take the lines, before writing anything", async () => {
    const tenLanguages = ["de", "fr", "es", "it", "pt", "nl", "sv", "da", "fi", "pl"];
    const crowded: AgentVoiceSettings = {
      ...operatorVoice,
      bridgeLines: Object.fromEntries(tenLanguages.map((tag) => [tag, { acknowledge: [], check: ["Un momento."] }])),
      fallbackLine: Object.fromEntries(tenLanguages.map((tag) => [tag, "Un momento, per favore."])),
    };
    const update = vi.fn(async () => undefined);

    await expect(seedVoiceSettings({
      agents: { findByIdAndWorkspaceId: async () => ({ voice: crowded, assistantDefaultLocale: null }) },
      agentSettings: { update },
    }, named)).rejects.toThrow(new RegExp(`${named.agentId}.*10 locales`, "u"));
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses an agent it cannot find rather than writing a voice block onto nothing", async () => {
    const update = vi.fn(async () => undefined);

    await expect(seedVoiceSettings({
      agents: { findByIdAndWorkspaceId: async () => null },
      agentSettings: { update },
    }, named)).rejects.toThrow(named.agentId);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("live runner shutdown", () => {
  const closers = (closed: string[], failing?: string) => {
    const step = (name: string) => async (): Promise<void> => {
      closed.push(name);
      if (name === failing) {
        throw new Error(`${name} failed`);
      }
    };
    return {
      realtimePublisherLifecycle: { shutdown: step("realtime publisher") },
      applicationModules: { shutdownAll: step("application modules") },
      closeApprovalResumeEffectJournal: step("approval journal"),
      closeAbuseControlRepository: step("abuse control"),
      connectorRegistry: { shutdownAll: step("connectors") },
      connectorDb: { close: step("pool") },
      logger: { error: vi.fn() },
    } as unknown as Parameters<typeof closeEvalDependencies>[0];
  };

  it("closes what the composition opened in the runtimes' order, then ends the pool", async () => {
    const closed: string[] = [];

    await closeEvalDependencies(closers(closed));

    expect(closed).toEqual(["realtime publisher", "application modules", "approval journal", "abuse control", "connectors", "pool"]);
  });

  it("still ends the pool after a step that fails, and reports that failure", async () => {
    const closed: string[] = [];

    await expect(closeEvalDependencies(closers(closed, "realtime publisher"))).rejects.toThrow("realtime publisher failed");
    expect(closed.at(-1)).toBe("pool");
  });

  it("keeps the run's own error when closing fails too, and reports the close failure", async () => {
    const reported: unknown[] = [];

    await expect(runThenClose(
      async () => { throw new Error("the run failed"); },
      async () => { throw new Error("closing failed"); },
      (error) => { reported.push(error); },
    )).rejects.toThrow("the run failed");
    expect(reported).toEqual([new Error("closing failed")]);
  });

  it("reports a close failure after a run that succeeded, without throwing it", async () => {
    const reported: unknown[] = [];

    await expect(runThenClose(
      async () => "done",
      async () => { throw new Error("closing failed"); },
      (error) => { reported.push(error); },
    )).resolves.toBe("done");
    expect(reported).toEqual([new Error("closing failed")]);
  });
});
