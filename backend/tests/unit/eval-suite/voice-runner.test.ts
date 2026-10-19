import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  formatVoiceLatencyReport,
  parseConversationQualityCases,
  recordVoiceBaseline,
  scopeVoiceCasesForLiveRun,
  scoreObservedOutput,
  summarizeVoiceCase,
  type VoiceTurnObservation,
} from "../../../src/modules/eval/suite/index.js";
import { conversationQualityVoiceCases, conversationQualityVoiceSettings } from "../../fixtures/conversation-quality/index.js";
import {
  observeVoiceTurn,
  readVoiceStream,
  voiceLineCatalog,
  type VoiceWireChunk,
  type VoiceWireRecording,
} from "../../../scripts/voiceEvalRunnerAdapter.js";

const BRIDGE = conversationQualityVoiceSettings.bridgeLines.en.check[0];
const FALLBACK = conversationQualityVoiceSettings.fallbackLine.en;
const lines = voiceLineCatalog(conversationQualityVoiceSettings);

/** A `chat.completion.chunk` frame as the completions door writes it. */
const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "radioso", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const DONE = "data: [DONE]\n\n";
const ERROR_FRAME = `data: ${JSON.stringify({ error: { message: "The agent could not finish this reply.", type: "server_error" } })}\n\n`;

/** A knowledge turn as the generic dialect streams it: the bridge on searching, the answer in two sentences, the stop. */
const bridgedTurn: VoiceWireChunk[] = [
  { atMs: 180, text: chunk({ role: "assistant", content: BRIDGE }) },
  { atMs: 2_400, text: chunk({ content: "You can ask for a refund within 30 days. " }) },
  // The socket cut the second sentence's frame in two; it completes with the second chunk.
  { atMs: 2_650, text: chunk({ content: "Just reply to your receipt." }).slice(0, 40) },
  { atMs: 2_700, text: chunk({ content: "Just reply to your receipt." }).slice(40) + chunk({}, "stop") + DONE },
];

const recording = (chunks: VoiceWireChunk[], overrides: Partial<VoiceWireRecording> = {}): VoiceWireRecording => ({
  status: 200,
  chunks,
  outcome: "continue",
  conversationId: "conversation-1",
  endedAtMs: chunks.at(-1)?.atMs ?? 0,
  ...overrides,
});

const observation = (
  overrides: Partial<Omit<VoiceTurnObservation, "timings">> & { timings?: Partial<VoiceTurnObservation["timings"]> } = {},
): VoiceTurnObservation => ({
  protocol: { ok: true },
  outcome: "continue",
  pieces: [{ kind: "speech", text: "Hello.", atMs: 900 }],
  ...overrides,
  timings: { firstByteMs: 900, bridgeMs: null, firstSpeechMs: 900, turnMs: 1_000, ...overrides.timings },
});

describe("the voice runner's measurement", () => {
  it("reads each content delta at the chunk that completed its frame, and the stream's end", () => {
    expect(readVoiceStream(bridgedTurn)).toEqual({
      deltas: [
        { text: BRIDGE, atMs: 180 },
        { text: "You can ask for a refund within 30 days. ", atMs: 2_400 },
        { text: "Just reply to your receipt.", atMs: 2_700 },
      ],
      done: true,
      errorFrame: false,
      unreadableFrames: 0,
    });
  });

  it("tells the bridge line from the answer, and times the first byte, the bridge, the first speech and the turn", () => {
    expect(observeVoiceTurn(recording(bridgedTurn, { endedAtMs: 2_710 }), lines)).toEqual({
      protocol: { ok: true },
      outcome: "continue",
      pieces: [
        { kind: "bridge", text: BRIDGE, atMs: 180 },
        { kind: "speech", text: "You can ask for a refund within 30 days. ", atMs: 2_400 },
        { kind: "speech", text: "Just reply to your receipt.", atMs: 2_700 },
      ],
      timings: { firstByteMs: 180, bridgeMs: 180, firstSpeechMs: 2_400, turnMs: 2_710 },
    });
  });

  it("names the fallback line spoken at the turn limit, and the callback outcome from the trailer", () => {
    const limited = observeVoiceTurn(recording([
      { atMs: 400, text: chunk({ role: "assistant", content: BRIDGE }) },
      { atMs: 10_000, text: chunk({ content: FALLBACK }) + chunk({}, "stop") + DONE },
    ], { outcome: "callback_requested" }), lines);

    expect(limited.pieces.map((piece) => piece.kind)).toEqual(["bridge", "fallback"]);
    expect(limited.outcome).toBe("callback_requested");
    expect(limited.timings.firstSpeechMs).toBe(10_000);
  });

  it.each([
    ["an error frame", recording([{ atMs: 300, text: chunk({ role: "assistant", content: BRIDGE }) + ERROR_FRAME }]), "The stream carried an error frame."],
    ["a cut stream", recording([{ atMs: 300, text: chunk({ role: "assistant", content: BRIDGE }) }]), "The stream ended without [DONE]."],
    ["a frame that is not JSON", recording([{ atMs: 300, text: `data: {not json\n\n${DONE}` }]), "The stream carried 1 frame(s) that are not chat.completion.chunk JSON."],
    ["no outcome trailer", recording(bridgedTurn, { outcome: null }), "The stream named no outcome in its trailer."],
    ["an unknown outcome", recording(bridgedTurn, { outcome: "transfer" }), "The stream named an unknown outcome \"transfer\"."],
    ["a refused request", recording([{ atMs: 20, text: "{\"code\":\"unauthorized\"}" }], { status: 401, outcome: null }), "The response was HTTP 401."],
  ])("calls %s a malformed turn", (_name, wire, problem) => {
    expect(observeVoiceTurn(wire, lines).protocol).toEqual({ ok: false, problem });
  });
});

describe("voice assertions", () => {
  const score = (assertions: Parameters<typeof scoreObservedOutput>[0], voiceTurn?: VoiceTurnObservation) =>
    scoreObservedOutput(assertions, { retrievedChunks: [], ...(voiceTurn ? { voiceTurn } : {}) }, { workspaceId: "w", question: "q", runId: "r" });

  it("fails a turn whose bridge, order, outcome or log differ, naming what was heard", async () => {
    const turn = observation({
      pieces: [{ kind: "bridge", text: BRIDGE, atMs: 0 }, { kind: "speech", text: "Hi.", atMs: 50 }],
      timings: { bridgeMs: 0, firstSpeechMs: 50 },
      turnRecord: {
        agentId: "agent-1",
        vendor: "generic",
        transport: "web",
        conversationId: null,
        result: "completed",
        durationMs: 50,
        speechPieceCount: 1,
        bridged: true,
        outcome: "continue",
        languageSource: "session",
      },
    });

    const { verdicts } = await score([
      { type: "voice_bridge_spoken", spoken: false },
      { type: "voice_speech_order", order: ["speech"] },
      { type: "voice_outcome", kind: "callback_requested" },
      { type: "voice_turn_record", fields: { bridged: false, languageSource: { absent: true }, conversationId: null, turnLanguage: { absent: true } } },
    ], turn);

    expect(verdicts.map((verdict) => [verdict.status, verdict.reason])).toEqual([
      ["fail", "A bridge line was spoken at 0 ms."],
      ["fail", "Heard bridge → speech; expected speech."],
      ["fail", "The outcome was \"continue\"."],
      ["fail", "bridged was true; expected false; languageSource was \"session\"; expected absent"],
    ]);
  });

  it("errors a voice assertion on a turn the runner could not observe as a voice turn, or without its record", async () => {
    expect((await score([{ type: "voice_outcome", kind: "continue" }])).status).toBe("error");
    expect((await score([{ type: "voice_turn_record", fields: { bridged: false } }], observation())).status).toBe("error");
  });
});

describe("the voice cases", () => {
  it("parse, and refuse a voice case that also carries text-turn inputs or lets a teammate act first", () => {
    expect(parseConversationQualityCases(conversationQualityVoiceCases)).toHaveLength(conversationQualityVoiceCases.length);
    const voiceCase = conversationQualityVoiceCases[0];
    expect(() => parseConversationQualityCases([{ ...voiceCase, history: [{ role: "user", content: "Hi" }] }])).toThrow(/a voice case takes only query and voice/u);
    expect(() => parseConversationQualityCases([{ ...voiceCase, voice: { before: [{ kind: "teammate_takes_over" }] } }])).toThrow(/the caller speaks first/u);
  });

  it("run live without the scripted-timing cases, gated on the wire's view of their behaviour", () => {
    const live = scopeVoiceCasesForLiveRun(conversationQualityVoiceCases);

    expect(live.map((evalCase) => evalCase.id)).toEqual([
      "voice-knowledge-bridge-on-search",
      "voice-greeting-quick-reply-no-bridge",
      "voice-callback-routine-requests-callback",
      "voice-human-owned-waiting-line",
      "voice-teammate-reply-spoken-first",
    ]);
    expect(new Set(live.flatMap((evalCase) => evalCase.assertions.map((assertion) => assertion.type)))).toEqual(
      new Set(["voice_turn_well_formed", "voice_bridge_spoken", "voice_outcome"]),
    );
    // A greeting bridges on a real model whenever its planner takes longer than the stall bridge.
    expect(live.find((evalCase) => evalCase.id === "voice-greeting-quick-reply-no-bridge")?.assertions).toEqual([
      { type: "voice_turn_well_formed" },
      { type: "voice_outcome", kind: "continue" },
    ]);
  });
});

describe("the live voice run", () => {
  const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;

  it("holds a committed baseline entry and latency slot for every case it drives", () => {
    const baseline = readJson("../../fixtures/conversation-quality/voice-baseline.json");
    const live = scopeVoiceCasesForLiveRun(conversationQualityVoiceCases).map((evalCase) => evalCase.id).sort();

    expect(Object.keys(baseline.cases ?? {}).sort()).toEqual(live);
    expect(Object.keys(baseline.latency ?? {}).sort()).toEqual(live);
  });

  it("gates and records at the same sampling depth", () => {
    const scripts = readJson("../../../package.json").scripts as Record<string, string>;

    expect(scripts["evals:voice:ci"]).toContain("--channel voice --samples 3");
    expect(scripts["evals:voice:update-baseline"]).toContain("--samples 3");
  });
});

describe("the voice report", () => {
  const knowledge = summarizeVoiceCase("voice-knowledge", [
    observation({ pieces: [], timings: { firstByteMs: 200, bridgeMs: 200, firstSpeechMs: 2_000, turnMs: 2_500 } }),
    observation({ pieces: [], timings: { firstByteMs: 100, bridgeMs: 100, firstSpeechMs: 6_000, turnMs: 6_500 } }),
    observation({ pieces: [], timings: { firstByteMs: 300, bridgeMs: 300, firstSpeechMs: 5_000, turnMs: 5_400 } }),
    { error: "The call's step 1 failed: The response was HTTP 503." },
  ]);
  const greeting = summarizeVoiceCase("voice-greeting", [
    observation({ timings: { firstByteMs: 900, firstSpeechMs: 900, turnMs: 950 } }),
    observation({ outcome: null, protocol: { ok: false, problem: "The stream ended without [DONE]." }, timings: { firstByteMs: 1_100, firstSpeechMs: 1_100, turnMs: 1_200 } }),
  ]);

  it("summarizes a case's samples out of every sample, an errored one included, with median times", () => {
    expect(knowledge).toMatchObject({ samples: 4, bridged: 3, outcomes: { continue: 3 }, protocolErrors: 0, errored: 1, firstByteMs: 200, bridgeMs: 200, firstSpeechMs: 5_000, turnMs: 5_400 });
    expect(greeting).toMatchObject({ samples: 2, bridged: 0, outcomes: { continue: 1, none: 1 }, protocolErrors: 1, errored: 0, bridgeMs: null, firstSpeechMs: 900 });
  });

  it("renders each case, the percentiles across every sample, the cases with no latency baseline, and a case past twice its baseline median", () => {
    const report = formatVoiceLatencyReport([knowledge, greeting], {
      "voice-knowledge": { firstByteMs: 150, firstSpeechMs: 2_400, turnMs: 2_900 },
      "voice-greeting": { firstByteMs: null, firstSpeechMs: null, turnMs: null },
    });

    expect(report).toBe([
      "Voice turns (medians across samples; latency is reported, never gated):",
      "  voice-knowledge: bridged 3/4, outcome continue 3/4, 1 errored | first byte 200 ms, bridge 200 ms, first speech 5000 ms, turn 5400 ms",
      "  voice-greeting: bridged 0/2, outcome continue 1/2, none 1/2, 1 malformed | first byte 900 ms, bridge -, first speech 900 ms, turn 950 ms",
      "  Across cases: first speech p50 2000 ms, p95 6000 ms; turn p50 2500 ms, p95 6500 ms",
      "  No latency baseline for 1 case(s): run `evals:voice:update-baseline` in CI (dispatch Conversation Quality Evals with record_voice_baseline) and commit the voice-baseline.json artifact it uploads.",
      "  Slower than 2x the baseline median (a warning; it does not fail the run):",
      "    ! voice-knowledge: first speech 5000 ms, baseline 2400 ms",
    ].join("\n"));
  });

  it("records the medians a run measured beside the statuses, keeping the cases a filtered run did not run", () => {
    const recorded = recordVoiceBaseline({
      previous: { passThreshold: 1, cases: { "voice-other": "pass", "voice-knowledge": "pass" }, latency: { "voice-other": { firstByteMs: 1, firstSpeechMs: 2, turnMs: 3 } } },
      outcomes: [{ caseId: "voice-knowledge", name: "Knowledge", status: "pass", passRate: 1, samples: 3 }],
      latencies: [knowledge],
      generatedAt: "2026-10-19T00:00:00.000Z",
      passThreshold: 1,
      filtered: true,
    });

    expect(recorded).toEqual({
      generatedAt: "2026-10-19T00:00:00.000Z",
      passThreshold: 1,
      cases: { "voice-other": "pass", "voice-knowledge": { status: "pass", passRate: 1, samples: 3 } },
      latency: {
        "voice-knowledge": { firstByteMs: 200, firstSpeechMs: 5_000, turnMs: 5_400 },
        "voice-other": { firstByteMs: 1, firstSpeechMs: 2, turnMs: 3 },
      },
    });
  });
});
