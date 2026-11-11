import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/shared/domain/errors.js";
import {
  VoiceTurnIncompleteError,
  type VoiceTestChatBinding,
  type VoiceTestChatTurnEvent,
  type VoiceTestChatTurns,
  type VoiceTurnEvent,
  type VoiceTurnInput,
  type VoiceTurnPort,
} from "../../src/modules/voiceChannel/domain.js";
import { TestChatVoiceTurnService, VoiceSessionTurnRouter } from "../../src/modules/voiceChannel/public.js";
import { isTestChatSessionKey, testChatSessionKey } from "../../src/modules/voiceChannel/testChatSessionDomain.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const testExecutionId = "77777777-7777-4777-8777-777777777777";
const accountId = "88888888-8888-4888-8888-888888888888";
const now = Date.parse("2026-11-11T12:00:00.000Z");

/** A key Radioso minted for a Test Chat session, and one a website start or a page minted. */
const TEST_CHAT_KEY = testChatSessionKey("33333333-3333-4333-8333-333333333333");
const WEBSITE_KEY = "33333333-3333-4333-8333-333333333333";

const turnInput = (utterance = "Do you open on Sundays?", sessionKey = TEST_CHAT_KEY): VoiceTurnInput => ({
  session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey },
  transport: "web",
  utterance,
  streamsSpeech: true,
});

const binding = (expiresAt = new Date(now + 60_000)): VoiceTestChatBinding => ({ testExecutionId, accountId, expiresAt });

const collect = async (events: AsyncIterable<VoiceTurnEvent>): Promise<VoiceTurnEvent[]> => {
  const seen: VoiceTurnEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

const spoken = (events: readonly VoiceTurnEvent[]): string =>
  events.filter((event): event is Extract<VoiceTurnEvent, { type: "speech" }> => event.type === "speech").map((event) => event.text).join("");

/** A test that answers with these events, recording what it was asked. */
const testAnswering = (...events: VoiceTestChatTurnEvent[]) => {
  const streamTurn = vi.fn<VoiceTestChatTurns["streamTurn"]>(async function* () {
    yield* events;
  });
  return { streamTurn };
};

const conversationPath = () => {
  const runTurn = vi.fn<VoiceTurnPort["runTurn"]>(async function* () {
    yield { type: "conversation", conversationId: "99999999-9999-4999-8999-999999999999" };
    yield { type: "speech", text: "The published agent answers.", last: true };
    yield { type: "outcome", outcome: { kind: "continue" } };
  });
  return { runTurn };
};

describe("a Test Chat voice turn (#1536)", () => {
  it("speaks the answer of the test's revision sentence by sentence as it is written, and goes on", async () => {
    const turns = testAnswering(
      { type: "text", text: "We open at nine. On Sun" },
      { type: "text", text: "days we stay closed." },
      { type: "answered", answer: "We open at nine. On Sundays we stay closed." },
    );
    const service = new TestChatVoiceTurnService({ turns, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });
    const signal = new AbortController().signal;

    const events = await collect(service.runTurn(turnInput(), binding(), signal));

    expect(events).toEqual([
      { type: "speech", text: "We open at nine. ", last: false },
      { type: "speech", text: "On Sundays we stay closed.", last: true },
      { type: "outcome", outcome: { kind: "continue" } },
    ]);
    expect(turns.streamTurn).toHaveBeenCalledWith({
      workspaceId,
      agentId,
      testExecutionId,
      accountId,
      utterance: "Do you open on Sundays?",
      signal,
    });
  });

  it("speaks what the stored answer adds past the text that streamed", async () => {
    const turns = testAnswering(
      { type: "text", text: "We open at nine." },
      { type: "answered", answer: "We open at nine. See you then." },
    );
    const service = new TestChatVoiceTurnService({ turns, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });

    const events = await collect(service.runTurn(turnInput(), binding(), new AbortController().signal));

    expect(spoken(events)).toBe("We open at nine. See you then.");
    expect(events.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
  });

  it("fails the turn when the test's turn failed, and logs the test's code but nothing said", async () => {
    const turns = testAnswering({ type: "text", text: "We open" }, { type: "failed", code: "runner_failed" });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = new TestChatVoiceTurnService({ turns, logger, now: () => now });

    await expect(collect(service.runTurn(turnInput(), binding(), new AbortController().signal))).rejects.toThrow("runner_failed");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "voice.test_chat_turn", workspaceId, agentId, testExecutionId, result: "failed", failureCode: "runner_failed" }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Sundays");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("We open");
  });

  it("fails a turn whose test stream ends without settling", async () => {
    const turns = testAnswering({ type: "text", text: "We open" });
    const service = new TestChatVoiceTurnService({ turns, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });

    await expect(collect(service.runTurn(turnInput(), binding(), new AbortController().signal))).rejects.toBeInstanceOf(VoiceTurnIncompleteError);
  });

  it("runs a newer utterance of the session once the running one has settled, so the test records both", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const asked: string[] = [];
    const streamTurn = vi.fn<VoiceTestChatTurns["streamTurn"]>(async function* (input) {
      asked.push(input.utterance);
      if (input.utterance === "first") await firstHeld;
      yield { type: "answered", answer: `Answer to ${input.utterance}.` };
    });
    const service = new TestChatVoiceTurnService({ turns: { streamTurn }, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });

    const first = collect(service.runTurn(turnInput("first"), binding(), new AbortController().signal));
    await vi.waitFor(() => expect(asked).toEqual(["first"]));
    const second = collect(service.runTurn(turnInput("second"), binding(), new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(["first"]);

    releaseFirst();
    expect(spoken(await first)).toBe("Answer to first.");
    expect(spoken(await second)).toBe("Answer to second.");
    expect(asked).toEqual(["first", "second"]);
  });

  it("runs no turn for the runtime's follow-up after a language switch, which no Test Chat turn asks for", async () => {
    const turns = testAnswering({ type: "answered", answer: "Never asked." });
    const service = new TestChatVoiceTurnService({ turns, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });

    const events = await collect(service.runTurn(
      { ...turnInput(), languageSwitchResult: { switchId: "switch-1", confirmed: true } },
      binding(),
      new AbortController().signal,
    ));

    expect(events).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
    expect(turns.streamTurn).not.toHaveBeenCalled();
  });
});

describe("a Test Chat voice turn that waits (#1536 review)", () => {
  /** A test whose first utterance is held until released, recording which utterances it ran. */
  const heldTest = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const asked: string[] = [];
    const streamTurn = vi.fn<VoiceTestChatTurns["streamTurn"]>(async function* (input) {
      asked.push(input.utterance);
      if (input.utterance === "first") await held;
      yield { type: "answered", answer: `Answer to ${input.utterance}.` };
    });
    return { turns: { streamTurn }, asked, release };
  };

  it("lets a newer utterance replace one still waiting, which then ends without running or being charged", async () => {
    const { turns, asked, release } = heldTest();
    const service = new TestChatVoiceTurnService({ turns, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });

    const first = collect(service.runTurn(turnInput("first"), binding(), new AbortController().signal));
    await vi.waitFor(() => expect(asked).toEqual(["first"]));
    const second = collect(service.runTurn(turnInput("second"), binding(), new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = collect(service.runTurn(turnInput("third"), binding(), new AbortController().signal));

    expect(await second).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
    release();
    expect(spoken(await first)).toBe("Answer to first.");
    expect(spoken(await third)).toBe("Answer to third.");
    expect(asked).toEqual(["first", "third"]);
  });

  it.each([
    ["the runtime hung up on it", "hungUp"],
    ["its request was aborted", "signal"],
  ] as const)("runs no turn for a waiting utterance once %s", async (_case, which) => {
    const { turns, asked, release } = heldTest();
    const service = new TestChatVoiceTurnService({ turns, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });
    const first = collect(service.runTurn(turnInput("first"), binding(), new AbortController().signal));
    await vi.waitFor(() => expect(asked).toEqual(["first"]));
    const request = new AbortController();
    const hangUp = new AbortController();
    const second = collect(service.runTurn(turnInput("second"), binding(), request.signal, hangUp.signal));

    (which === "hungUp" ? hangUp : request).abort();
    release();

    expect(await second).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
    await first;
    expect(asked).toEqual(["first"]);
  });

  it("reads the test's turn to its end before the outcome, so the test settles and audits it", async () => {
    let drained = false;
    const streamTurn = vi.fn<VoiceTestChatTurns["streamTurn"]>(async function* () {
      yield { type: "answered", answer: "We open at nine." };
      // What the test does after the answer: it reads its settled state and audits the turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      drained = true;
    });
    const service = new TestChatVoiceTurnService({ turns: { streamTurn }, logger: { info: vi.fn(), warn: vi.fn() }, now: () => now });

    const seen: Array<{ event: VoiceTurnEvent; drained: boolean }> = [];
    for await (const event of service.runTurn(turnInput(), binding(), new AbortController().signal)) seen.push({ event, drained });

    expect(seen.at(-1)).toEqual({ event: { type: "outcome", outcome: { kind: "continue" } }, drained: true });
    expect(spoken(seen.map(({ event }) => event))).toBe("We open at nine.");
  });
});

describe("the voice turn router (#1536)", () => {
  const routerWith = (lookup: (session: VoiceTurnInput["session"]) => Promise<VoiceTestChatBinding | null>) => {
    const conversations = conversationPath();
    const testChat = { runTurn: vi.fn<TestChatVoiceTurnService["runTurn"]>(async function* () {
      yield { type: "speech", text: "The draft answers.", last: true };
      yield { type: "outcome", outcome: { kind: "continue" } };
    }) };
    const logger = { warn: vi.fn() };
    const router = new VoiceSessionTurnRouter({
      bindings: { findTestChatBinding: vi.fn(lookup) },
      conversations,
      testChats: testChat,
      now: () => now,
      logger,
    });
    return { router, conversations, testChat, logger };
  };

  it("runs a session outside Test Chat's key namespace as a conversation on the published agent, without a lookup", async () => {
    const lookup = vi.fn(async () => binding());
    const { router, conversations, testChat } = routerWith(lookup);
    const input = turnInput("Hello", WEBSITE_KEY);
    const signal = new AbortController().signal;
    const hungUp = new AbortController().signal;

    expect(spoken(await collect(router.runTurn(input, signal, hungUp)))).toBe("The published agent answers.");
    expect(conversations.runTurn).toHaveBeenCalledWith(input, signal, hungUp);
    expect(testChat.runTurn).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a Test Chat key whose session row is gone, and never runs it as a conversation", async () => {
    const { router, conversations, testChat } = routerWith(async () => null);

    await expect(collect(router.runTurn(turnInput(), new AbortController().signal))).rejects.toMatchObject({ statusCode: 404 });
    expect(conversations.runTurn).not.toHaveBeenCalled();
    expect(testChat.runTurn).not.toHaveBeenCalled();
  });

  it("mints Test Chat keys in their own namespace, apart from a website start's", () => {
    expect(isTestChatSessionKey(TEST_CHAT_KEY)).toBe(true);
    expect(isTestChatSessionKey(WEBSITE_KEY)).toBe(false);
    expect(isTestChatSessionKey("conv_01jabcdef")).toBe(false);
  });

  it("runs a Test Chat session's turn on its test, never on the published agent's path", async () => {
    const bound = binding();
    const { router, conversations, testChat } = routerWith(async () => bound);
    const input = turnInput();
    const signal = new AbortController().signal;
    const hungUp = new AbortController().signal;

    expect(spoken(await collect(router.runTurn(input, signal, hungUp)))).toBe("The draft answers.");
    expect(testChat.runTurn).toHaveBeenCalledWith(input, bound, signal, hungUp);
    expect(conversations.runTurn).not.toHaveBeenCalled();
  });

  it("refuses a turn on a Test Chat session past its window, on either path", async () => {
    const { router, conversations, testChat, logger } = routerWith(async () => binding(new Date(now - 1)));

    const refused = collect(router.runTurn(turnInput(), new AbortController().signal));

    await expect(refused).rejects.toBeInstanceOf(AppError);
    await expect(refused).rejects.toMatchObject({ statusCode: 404 });
    expect(conversations.runTurn).not.toHaveBeenCalled();
    expect(testChat.runTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "voice.test_chat_turn", result: "session_ended", testExecutionId }),
      expect.any(String),
    );
  });

  it("never falls back to the published agent when it cannot tell whether a session is a Test Chat one", async () => {
    const { router, conversations, testChat } = routerWith(async () => {
      throw new Error("connection terminated");
    });

    await expect(collect(router.runTurn(turnInput(), new AbortController().signal))).rejects.toThrow("connection terminated");
    expect(conversations.runTurn).not.toHaveBeenCalled();
    expect(testChat.runTurn).not.toHaveBeenCalled();
  });
});
