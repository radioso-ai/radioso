import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../../src/modules/chat/contracts/index.js";
import { TurnPlanCoordinator } from "../../../src/modules/chat/services/turnPlanCoordinator.js";
import { TurnPlanService } from "../../../src/modules/chat/services/turnPlanService.js";
import {
  runConversationQualitySuite,
  type ConversationQualityCase,
  type VoiceTurnObservation,
} from "../../../src/modules/eval/suite/index.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import type { TurnPlanGatewayFactory } from "../../../src/shared/infra/llm/turnPlanGateway.js";
import {
  conversationQualityVoiceCases,
  conversationQualityVoiceSettings,
  voiceCallbackRoutineDraft,
} from "../../fixtures/conversation-quality/index.js";
import { createTestApp } from "../../support/testApp.js";
import { openVoiceRuntime } from "../../support/voiceRuntime.js";
import {
  createVoiceCallRunnerPort,
  ownershipTeammate,
  voiceLineCatalog,
  type VoiceTurnLogReader,
} from "../../../scripts/voiceEvalRunnerAdapter.js";

/**
 * The deterministic half of the voice cases: every case through the `generic` dialect of the
 * test app's completions door over a real socket, with a scripted brain and the policy on a fake
 * clock, so the bridge, the turn limit and the times a runtime would hear them are exact.
 */

const ANSWER = "You can ask for a refund within 30 days of purchase.";
const WAITING_LINE = "Thanks for waiting, a teammate is joining you now.";
const CALLBACK_QUESTION = "What number should we call you back on?";
const CALLBACK_CONFIRMATION = "A teammate will call you back shortly.";

/** Only the clock is fake: sockets and setImmediate stay real so frames can travel. */
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "Date"] };
/** Every time a case pins is a multiple of the step, so the pump lands on it exactly. */
const PUMP_STEP_MS = 50;
const PUMP_LIMIT_MS = 60_000;
/** A case builds a test app and runs up to 12 s of fake time; the default 10 s of wall time is tight under a loaded CI. */
const CASE_TIMEOUT_MS = 30_000;

const flushIo = async (): Promise<void> => {
  for (let tick = 0; tick < 30; tick += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Waits for `pending`, moving the fake clock a step at a time once the sockets have gone quiet. */
const settle = async <T>(pending: Promise<T>): Promise<T> => {
  let outcome: { value: T } | { error: unknown } | undefined;
  pending.then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  for (let elapsed = 0; ; elapsed += PUMP_STEP_MS) {
    await flushIo();
    if (outcome) break;
    if (elapsed > PUMP_LIMIT_MS) throw new Error(`Nothing settled within ${PUMP_LIMIT_MS} ms of fake time.`);
    await vi.advanceTimersByTimeAsync(PUMP_STEP_MS);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A planner that plans every turn the same: a direct answer the composer writes, or the planner's own quick reply. */
const plannerAnswering = (quickReply?: { kind: string; text: string }): TurnPlanCoordinator => {
  const factory: TurnPlanGatewayFactory = {
    create: async () => ({
      complete: async () => ({
        text: JSON.stringify({
          route: "direct",
          isIdentityQuestion: false,
          intentTopic: null,
          rewrite: null,
          responseLanguage: "English",
          responseLanguageTag: "en",
          requestPresent: quickReply === undefined,
          openQuestion: false,
          quickReply: quickReply ? { ...quickReply, language: "en" } : { kind: "none", language: null, text: "" },
        }),
      }),
    }),
  };
  return new TurnPlanCoordinator(new TurnPlanService(factory));
};

/** A composer that says `text` after `silenceMs` of the fake clock. */
const composerAfter = (silenceMs: number, text = ANSWER): ChatGateway => ({
  answer: async () => {
    await sleep(silenceMs);
    return text;
  },
  async *streamAnswer() {
    await sleep(silenceMs);
    yield text;
  },
});

/**
 * The callback routine's model: it starts the routine on the caller's ask, holds the step's
 * condition met once the caller's message carries a number, and otherwise writes the routine's
 * lines.
 */
const callbackRoutineModel = (routineId: () => string): ChatGateway => {
  const reply = ({ systemPrompt, query }: { systemPrompt?: string; query: string }): string => {
    if (systemPrompt?.includes("wants to start any registered routine")) {
      return JSON.stringify({ matches: [{ routineId: routineId(), confidence: 0.95, variables: {} }] });
    }
    if (systemPrompt?.includes("Decide what should")) {
      const phone = /\d[\d ]{6,}\d/u.exec(query)?.[0];
      return JSON.stringify({ claimsAuthority: false, condition: phone ? 1 : null, offTopic: false, variables: phone ? { phone } : {} });
    }
    return systemPrompt?.includes("will ring them on") ? CALLBACK_CONFIRMATION : CALLBACK_QUESTION;
  };
  return {
    answer: async (input) => reply(input),
    async *streamAnswer(input) {
      yield reply(input);
    },
  };
};

type BrainOverrides = Pick<
  NonNullable<Parameters<typeof createTestApp>[0]>,
  "chatGateway" | "turnPlanCoordinator" | "handoffWaitingMessageGenerator"
>;

/** What each case's brain does: the scenario's timing and content, scripted, and the times it pins on the fake clock. */
interface ScriptedBrain {
  overrides: (routineId: () => string) => BrainOverrides;
  /** The case completes this routine, created on the agent before the call. */
  routine?: typeof voiceCallbackRoutineDraft;
  /** When the scored turn's bridge and first speech reach the runtime, in ms of the fake clock. */
  times: Pick<VoiceTurnObservation["timings"], "bridgeMs" | "firstSpeechMs">;
}

const scriptedBrains: Record<string, ScriptedBrain> = {
  // No planner: the staged path routes a question to retrieval, which reports `searching`.
  "voice-knowledge-bridge-on-search": {
    overrides: () => ({ chatGateway: composerAfter(0) }),
    times: { bridgeMs: 0, firstSpeechMs: 0 },
  },
  "voice-greeting-quick-reply-no-bridge": {
    overrides: () => ({ chatGateway: composerAfter(0), turnPlanCoordinator: plannerAnswering({ kind: "greeting", text: "Hello, how can I help you today?" }) }),
    times: { bridgeMs: null, firstSpeechMs: 0 },
  },
  // Silent past the composing idle (400 ms), well inside the stall bridge (2.5 s) and the limit.
  "voice-slow-composer-bridges-after-idle": {
    overrides: () => ({ chatGateway: composerAfter(1_500), turnPlanCoordinator: plannerAnswering() }),
    times: { bridgeMs: 400, firstSpeechMs: 1_500 },
  },
  // Silent past the turn limit (10 s); the reply drains unheard behind the fallback line.
  "voice-stalled-reply-turn-limit": {
    overrides: () => ({ chatGateway: composerAfter(12_000), turnPlanCoordinator: plannerAnswering() }),
    times: { bridgeMs: 400, firstSpeechMs: 10_000 },
  },
  "voice-callback-routine-requests-callback": {
    overrides: (routineId) => ({ chatGateway: callbackRoutineModel(routineId) }),
    routine: voiceCallbackRoutineDraft,
    times: { bridgeMs: null, firstSpeechMs: 0 },
  },
  // Chat's waiting line takes longer than the turn limit, so a limit or a stall bridge would show.
  "voice-human-owned-waiting-line": {
    overrides: () => ({
      chatGateway: composerAfter(0),
      handoffWaitingMessageGenerator: { generate: async () => { await sleep(11_000); return WAITING_LINE; } },
    }),
    times: { bridgeMs: null, firstSpeechMs: 11_000 },
  },
  "voice-teammate-reply-spoken-first": {
    overrides: () => ({ chatGateway: composerAfter(0) }),
    times: { bridgeMs: null, firstSpeechMs: 0 },
  },
};

const TURN_RECORD_MESSAGES = new Set(["Voice turn finished", "Voice turn reached the turn limit", "Voice turn failed"]);

/** The voice turns' log records as the test app's logger receives them. */
const turnLogsOf = (logger: ReturnType<typeof createLogger>): VoiceTurnLogReader => {
  const records: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  const capture = (fields: unknown, message?: unknown): void => {
    if (typeof message === "string" && TURN_RECORD_MESSAGES.has(message)) {
      records.push(fields as Record<string, unknown>);
      waiters.splice(0).forEach((wake) => wake());
    }
  };
  vi.spyOn(logger, "info").mockImplementation(capture);
  vi.spyOn(logger, "warn").mockImplementation(capture);
  return {
    count: () => records.length,
    next: async (after) => {
      while (records.length <= after) await new Promise<void>((wake) => waiters.push(wake));
      return records[after];
    },
  };
};

/** A test app for one case, serving on a real socket, and the runner port that calls it. */
const voiceStackFor = async (evalCase: ConversationQualityCase): Promise<{ server: Server; port: ReturnType<typeof createVoiceCallRunnerPort> }> => {
  const brain = scriptedBrains[evalCase.id];
  if (!brain) throw new Error(`Case "${evalCase.id}" has no scripted brain.`);
  const logger = createLogger("silent");
  const turnLogs = turnLogsOf(logger);
  let routineId = "";
  const testApp = createTestApp({ logger, ...brain.overrides(() => routineId) });
  const runtime = await settle(openVoiceRuntime(testApp, {
    emailPrefix: "voice-eval",
    agentSettings: { assistantDefaultLocale: "en", voice: conversationQualityVoiceSettings },
  }));
  if (brain.routine) {
    routineId = (await settle(testApp.dependencies.routineDefinitionService.createDraft(runtime.session.workspaceId, runtime.agentId, brain.routine))).routine.id;
  }
  const server = testApp.app.listen(0, "127.0.0.1");
  await settle(once(server, "listening"));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port: createVoiceCallRunnerPort({
      door: { origin: `http://127.0.0.1:${port}`, agentId: runtime.agentId, token: runtime.runtimeToken },
      teammate: ownershipTeammate(testApp.dependencies.conversationOwnershipService, {
        accountId: runtime.session.accountId,
        userId: runtime.session.userId,
        workspaceId: runtime.session.workspaceId,
      }),
      lines: voiceLineCatalog(conversationQualityVoiceSettings),
      clock: () => Date.now(),
      settle,
      turnLogs,
    }),
  };
};

describe("voice cases over the test app (deterministic half)", () => {
  const servers: Server[] = [];

  beforeEach(() => {
    vi.useFakeTimers(FAKE_CLOCK);
  });

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Runs one case and returns its report and the observation it was scored on. */
  const runCase = async (evalCase: ConversationQualityCase) => {
    const { server, port } = await voiceStackFor(evalCase);
    servers.push(server);
    const observed: Array<Awaited<ReturnType<NonNullable<typeof port.voice>>>> = [];
    const recording = { ...port, voice: async (voiceCase: ConversationQualityCase) => {
      const output = await port.voice!(voiceCase);
      observed.push(output);
      return output;
    } };
    const { reports } = await runConversationQualitySuite([evalCase], recording, { workspaceId: "voice-eval" });
    return { report: reports[0], turn: observed[0]?.voiceTurn };
  };

  it("ships one scripted brain per voice case, and the live run keeps at most five", () => {
    expect(Object.keys(scriptedBrains).sort()).toEqual(conversationQualityVoiceCases.map((evalCase) => evalCase.id).sort());
    expect(conversationQualityVoiceCases.filter((evalCase) => !evalCase.voice?.requiresScriptedTiming).length).toBeLessThanOrEqual(5);
  });

  it.each(conversationQualityVoiceCases.map((evalCase) => [evalCase.id, evalCase] as const))(
    "passes %s, at the times its scripted brain pins",
    async (_id, evalCase) => {
      const { report, turn } = await runCase(evalCase);

      if (report.status !== "pass") {
        throw new Error(`expected pass, got ${report.status}: ${JSON.stringify(report.verdicts, null, 2)}`);
      }
      expect(turn?.timings).toMatchObject(scriptedBrains[evalCase.id].times);
    },
  );
});
