import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

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
  collectVoiceTurnRecords,
  createVoiceCallRunnerPort,
  observeVoiceTurn,
  postVoiceTurn,
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

  it("hears nothing in a delta of whitespace or zero-width spaces", () => {
    const padded = observeVoiceTurn(recording([
      { atMs: 100, text: chunk({ role: "assistant", content: " \u200B" }) },
      { atMs: 2_500, text: chunk({ content: "\n " }) },
      { atMs: 3_000, text: chunk({ content: "We open at nine." }) + chunk({}, "stop") + DONE },
    ]), lines);

    expect(padded.pieces).toEqual([{ kind: "speech", text: "We open at nine.", atMs: 3_000 }]);
    expect(padded.timings).toMatchObject({ firstByteMs: 100, firstSpeechMs: 3_000 });
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
    ["a stream cut in the middle of a frame", recording([{ atMs: 300, text: chunk({ role: "assistant", content: BRIDGE }) + chunk({ content: "We open" }).slice(0, 30) }]), "The stream ended without [DONE]."],
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

  it("refuse a turn-record assertion that names no field, or a field a turn's record never carries", () => {
    const voiceCase = conversationQualityVoiceCases[0];
    const withRecord = (fields: Record<string, unknown>) => [{ ...voiceCase, assertions: [{ type: "voice_turn_record", fields }] }];

    expect(() => parseConversationQualityCases(withRecord({}))).toThrow(/names at least one field/u);
    expect(() => parseConversationQualityCases(withRecord({ bridgedd: true }))).toThrow();
    expect(parseConversationQualityCases(withRecord({ bridged: true, conversationId: null }))).toHaveLength(1);
  });

  it("always gate a live case on a well-formed stream, and refuse one that would gate nothing else", () => {
    const base = { id: "voice-x", name: "Voice: x", voice: {}, query: "Hi" };

    expect(scopeVoiceCasesForLiveRun([{ ...base, assertions: [{ type: "voice_outcome", kind: "continue" }] }])[0]?.assertions).toEqual([
      { type: "voice_turn_well_formed" },
      { type: "voice_outcome", kind: "continue" },
    ]);
    expect(() => scopeVoiceCasesForLiveRun([{
      ...base,
      assertions: [{ type: "voice_turn_well_formed" }, { type: "voice_bridge_spoken", spoken: false, latencyDependent: true }, { type: "voice_speech_piece_count", count: 1 }],
    }])).toThrow(/gates nothing live beyond a well-formed stream/u);
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

describe("the voice runner on the wire", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  /** A runtime's door served by `handle`, which is told each request's order on the server. */
  const serve = async (handle: (request: number, req: http.IncomingMessage, res: http.ServerResponse) => void) => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => handle(requests++, req, res));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, agentId: "agent-1", token: "token" };
  };
  const openStream = (res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/event-stream", trailer: "X-Radioso-Voice-Outcome" });
  };
  const endStream = (res: http.ServerResponse): void => {
    res.write(chunk({}, "stop") + DONE);
    res.addTrailers({ "X-Radioso-Voice-Outcome": "continue" });
    res.end();
  };

  it("resolves a stream the server cuts off mid-way with what it carried, read as a cut stream", async () => {
    const door = await serve((_request, _req, res) => {
      openStream(res);
      res.write(chunk({ role: "assistant", content: "We open at nine. " }), () => res.socket?.destroy());
    });

    const cut = await postVoiceTurn(door, { sessionKey: "s", utterance: "When do you open?" });

    expect(observeVoiceTurn(cut, lines)).toMatchObject({
      protocol: { ok: false, problem: "The stream ended without [DONE]." },
      outcome: null,
      pieces: [{ kind: "speech", text: "We open at nine. " }],
    });
  });

  const interruptedCase = parseConversationQualityCases([{
    id: "voice-cut",
    name: "Voice: cut",
    voice: { interruption: { utterance: "Thanks.", afterSpeechPieces: 1 } },
    query: "When do you open?",
    assertions: [{ type: "voice_turn_well_formed" }],
  }])[0];
  const stackFor = (door: Awaited<ReturnType<typeof serve>>) => ({
    door,
    teammate: { takeOver: async () => undefined, reply: async () => undefined, handBack: async () => undefined },
    conversations: { conversationOf: async () => null },
    lines,
  });

  it.each([
    ["is cut off mid-way", (res: http.ServerResponse) => { openStream(res); res.write(chunk({ role: "assistant", content: "Bye" }), () => res.socket?.destroy()); }, "The stream ended without [DONE]."],
    ["never answers", (res: http.ServerResponse) => res.socket?.destroy(), "socket hang up"],
  ])("reports, and never leaves unhandled, an utterance spoken over the turn whose request %s", async (_name, failNewer, problem) => {
    let releaseScored!: () => void;
    const newerArrived = new Promise<void>((resolve) => { releaseScored = resolve; });
    const door = await serve((request, _req, res) => {
      if (request === 0) {
        openStream(res);
        res.write(chunk({ role: "assistant", content: "We open at nine. " }));
        void newerArrived.then(() => endStream(res));
        return;
      }
      failNewer(res);
      releaseScored();
    });

    const output = createVoiceCallRunnerPort(stackFor(door)).voice!(interruptedCase);

    await expect(output).rejects.toThrow(`The utterance spoken over the scored turn failed: ${problem}`);
  });

  it("gives the scored turn its own record when the utterance spoken over it finishes first", async () => {
    const records = collectVoiceTurnRecords();
    const summary = (result: "completed" | "superseded") => ({
      agentId: "agent-1", vendor: "generic", transport: "web" as const, conversationId: "conversation-1", result, durationMs: 1, speechPieceCount: 1,
    });
    let releaseScored!: () => void;
    const newerArrived = new Promise<void>((resolve) => { releaseScored = resolve; });
    const door = await serve((request, req, res) => {
      const sessionKey = String(req.headers["x-radioso-voice-session"]);
      if (request === 0) {
        openStream(res);
        res.write(chunk({ role: "assistant", content: "We open at nine. " }));
        // The cut turn's record arrives after the newer turn's, with the earlier arrival.
        void newerArrived.then(() => {
          endStream(res);
          setTimeout(() => records.turnFinished({ sessionKey, sequence: 1 }, summary("superseded")), 20);
        });
        return;
      }
      openStream(res);
      res.write(chunk({ role: "assistant", content: "You're welcome." }));
      endStream(res);
      records.turnFinished({ sessionKey, sequence: 2 }, summary("completed"));
      releaseScored();
    });

    const output = await createVoiceCallRunnerPort({ ...stackFor(door), turnRecords: records }).voice!(interruptedCase);

    expect(output.voiceTurn?.turnRecord?.result).toBe("superseded");
  });
});
