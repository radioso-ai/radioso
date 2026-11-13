import { afterAll, beforeAll, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { routineConsentWordingVersionId } from "../../src/shared/domain/routineConsentWording.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import {
  CONSENT_ROUTINE_ID as ROUTINE_ID,
  classBooking,
  consentWording as wording,
  createRoutineConsentChatHarness,
} from "./support/routineConsentChatHarness.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// What the scripted model reads a visitor's message as: slot values, and a reply to the consent.
const slotValues: Record<string, Record<string, string>> = {
  "My name is Ada": { name: "Ada" },
  "Yes, and I have a sore knee": { injury: "sore knee" },
  "I have a sore knee": { injury: "sore knee" },
};
const consentReadings: Record<string, string> = {
  "Yes, and I have a sore knee": "granted",
  "No": "declined",
};
const UNCLEAR_ANSWER = "We use it only to adapt your class.";

/** The model, scripted by the system prompt each routine call sends. */
const scriptedModel: ChatGateway = {
  async answer(input) {
    const prompt = input.systemPrompt ?? "";
    if (prompt.includes("wants to start any registered routine")) {
      return JSON.stringify({ matches: [{ routineId: ROUTINE_ID, confidence: 0.95, variables: {} }] });
    }
    if (prompt.includes("A person was just shown the consent request")) {
      return JSON.stringify({ decision: consentReadings[input.query] ?? "unclear" });
    }
    if (prompt.includes("answered without clearly agreeing or")) {
      return UNCLEAR_ANSWER;
    }
    if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
      return JSON.stringify({ variables: slotValues[input.query] ?? {}, claimsAuthority: false, condition: null, offTopic: false });
    }
    return `[step reply to: ${input.query}]`;
  },
  async *streamAnswer() {
    throw new Error("consent turns run the non-streaming path");
  },
};

describeIntegration("routine consent through a chat turn (Postgres, #1544)", () => {
  const database = new Database(integrationDatabaseUrl);
  const harness = createRoutineConsentChatHarness(database, scriptedModel);
  const { logged } = harness;

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await harness.cleanup();
    await database.close().catch(() => undefined);
  });

  /** A workspace whose published agent runs the class booking, and one conversation with it on `sourceChannel`. */
  const startConversation = (input: { onDecline?: "continue" | "handoff"; sourceChannel?: string } = {}) =>
    harness.startConversation({ definition: classBooking(input.onDecline ?? "continue"), sourceChannel: input.sourceChannel });

  const versionId = routineConsentWordingVersionId(wording);

  it("shows the wording verbatim with its two choices, then collects the field only after a typed grant", async () => {
    const conversation = await startConversation();
    await conversation.send("I want to book a class");

    const asked = await conversation.send("My name is Ada");
    expect(asked.answer).toBe(wording.body);
    expect(asked.suggestions).toEqual([
      { id: "agree", text: "I agree", kind: "authored", action: { kind: "ask_followup" } },
      { id: "decline", text: "No thanks", kind: "authored", action: { kind: "ask_followup" } },
    ]);
    const shownReply = (await conversation.messages()).at(-1)!;
    expect(shownReply.metadata_json?.consentPrompt).toEqual({ routineId: ROUTINE_ID, consentKey: "health", wordingVersionId: versionId, locale: "en" });
    expect(await conversation.records()).toEqual([]);

    const granted = await conversation.send("Yes, and I have a sore knee");
    const grantMessage = (await conversation.messages()).filter((message) => message.role === "user").at(-1)!;
    expect(await conversation.records()).toEqual([{
      id: expect.any(String),
      decision: "granted",
      method: "reply",
      defaulted: false,
      channel: "website_embed",
      visitor_id: conversation.visitorId,
      agent_id: conversation.agentId,
      slot_keys: ["injury"],
      wording_version_id: versionId,
      locale: "en",
      decision_message_id: grantMessage.id,
    }]);
    // The message that grants consent fills no covered field; the step asks for it next.
    expect(granted.answer).toContain("[step reply to:");
    expect((await conversation.routineState())?.variables).toEqual({ name: "Ada" });
    // It may state the value all the same, so it reads as withheld wherever the transcript goes.
    expect(grantMessage.metadata_json?.sensitiveSlotKeys).toEqual(["injury"]);

    await conversation.send("I have a sore knee");
    expect((await conversation.routineState())?.variables).toMatchObject({ name: "Ada", injury: "sore knee" });
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "routine_consent_shown", conversationId: conversation.conversationId, consentKey: "health", reask: false }),
      expect.objectContaining({ event: "routine_consent_decided", conversationId: conversation.conversationId, decision: "granted", method: "reply" }),
    ]));
  });

  it("records a click on the agree button as a button decision on the wording that prompt showed, whatever the label says", async () => {
    const conversation = await startConversation();
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    const shownReply = (await conversation.messages()).at(-1)!;

    // After a reload the chat still offers the two choices with the wording.
    const restored = (await conversation.reloaded()).find((message) => message.id === shownReply.id);
    expect(restored?.suggestions).toEqual([
      expect.objectContaining({ id: "agree", text: "I agree" }),
      expect.objectContaining({ id: "decline", text: "No thanks" }),
    ]);

    // The scripted model would read this text as a decline; the chip id decides.
    await conversation.send("No", { method: "suggestion_click", suggestionSourceMessageId: shownReply.id, suggestionId: "agree" });

    expect((await conversation.records()).map(({ decision, method, wording_version_id }) => ({ decision, method, wording_version_id })))
      .toEqual([{ decision: "granted", method: "button", wording_version_id: versionId }]);
    await conversation.send("I have a sore knee");
    expect((await conversation.routineState())?.variables).toMatchObject({ name: "Ada", injury: "sore knee" });
  });

  it("reads a click on a prompt the conversation no longer shows last as a typed reply", async () => {
    const conversation = await startConversation({ sourceChannel: "email" });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    const firstPrompt = (await conversation.messages()).at(-1)!;
    await conversation.send("What do you do with it?");

    await conversation.send("No", { method: "suggestion_click", suggestionSourceMessageId: firstPrompt.id, suggestionId: "agree" });

    expect((await conversation.records()).map(({ decision, method }) => ({ decision, method }))).toEqual([{ decision: "declined", method: "reply" }]);
  });

  it("runs on without the field when a visitor declines a consent that continues", async () => {
    const conversation = await startConversation({ onDecline: "continue" });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");

    await conversation.send("No");

    expect((await conversation.records()).map(({ decision, defaulted }) => ({ decision, defaulted }))).toEqual([{ decision: "declined", defaulted: false }]);
    const state = await conversation.routineState();
    expect(state?.status).toBe("completed");
    expect(state?.variables).toEqual({ name: "Ada" });
  });

  it("hands the conversation to a person when a visitor declines a consent that hands off", async () => {
    const conversation = await startConversation({ onDecline: "handoff" });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");

    await conversation.send("No");

    expect((await conversation.records()).map(({ decision }) => decision)).toEqual(["declined"]);
    const ownership = await database.query<{ state: string; reason: string | null }>(
      "SELECT state, reason FROM conversation_ownership WHERE conversation_id = $1",
      [conversation.conversationId],
    );
    expect(ownership).toEqual([{ state: "human_owned", reason: "routine_consent_declined" }]);
  });

  it("answers an unclear reply from the wording and asks again, then records a decline after a second unclear reply", async () => {
    const conversation = await startConversation({ sourceChannel: "email" });
    await conversation.send("I want to book a class");
    const asked = await conversation.send("My name is Ada");
    expect(asked.answer).toBe(`${wording.body}\n\n${wording.agreeLabel}\n\n${wording.declineLabel}`);

    const askedAgain = await conversation.send("What do you do with it?");
    expect(askedAgain.answer).toBe(`${UNCLEAR_ANSWER}\n\n${wording.body}\n\n${wording.agreeLabel}\n\n${wording.declineLabel}`);
    expect(await conversation.records()).toEqual([]);

    await conversation.send("Maybe later");
    expect((await conversation.records()).map(({ decision, defaulted, channel }) => ({ decision, defaulted, channel })))
      .toEqual([{ decision: "declined", defaulted: true, channel: "email" }]);
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "routine_consent_shown", conversationId: conversation.conversationId, reask: true }),
      expect.objectContaining({ event: "routine_consent_defaulted", conversationId: conversation.conversationId }),
    ]));
  });

  it("asks nothing and records nothing on a voice call, and the routine takes the decline path", async () => {
    const conversation = await startConversation({ sourceChannel: "voice" });
    await conversation.send("I want to book a class");

    const reply = await conversation.send("My name is Ada");

    expect(reply.answer).not.toBe(wording.body);
    expect(await conversation.records()).toEqual([]);
    expect((await conversation.messages()).some((message) => message.metadata_json?.consentPrompt)).toBe(false);
    expect(await conversation.routineState()).toMatchObject({ status: "completed", variables: { name: "Ada" } });
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "routine_consent_skipped", conversationId: conversation.conversationId, reason: "channel" }),
    ]));
  });
});
