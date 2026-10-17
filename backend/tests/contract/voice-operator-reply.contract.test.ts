import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

type HistoryMessage = { id: string; source: string; content: string; speech?: { state: string; spokenAt?: string } };

/**
 * A workspace whose default agent answers a voice runtime on the REST agent channel, and a call
 * on it: the runtime's turns for one session key, the teammate's Inbox actions on the call's
 * conversation, and the call as the Inbox reads it.
 */
const callWorkspace = async () => {
  const { app, dependencies, repositories } = createTestApp();
  const session = await issueTestSession(app, `voice-reply-${randomUUID()}@example.com`);
  const dashboard = adminSessionHeaders(session);
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  const runtimeCredential = await dependencies.accessGrantService.issueGrant({
    agentId,
    workspaceId: session.workspaceId,
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 600_000),
  });
  const sessionKey = randomUUID();

  /** One caller utterance as the voice runtime sends it; resolves what the caller hears. */
  const callerSays = async (utterance: string) => {
    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeCredential.token}`)
      .send({ messages: [{ role: "user", content: utterance }], stream: false, elevenlabs_extra_body: { session_key: sessionKey } })
      .expect(200);
    return { heard: response.body.choices[0].message.content as string, outcome: response.headers["x-radioso-voice-outcome"] };
  };
  const conversationId = async (): Promise<string> => {
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const conversations = history.body.conversations as Array<{ id: string; channelContext?: { sessionKey?: string } | null }>;
    return conversations.find((conversation) => conversation.channelContext?.sessionKey === sessionKey)!.id;
  };
  const detail = async (id: string) => (await request(app).get(`/api/v1/history/chat/${id}`).set(dashboard).expect(200)).body as {
    messages: HistoryMessage[];
    ownership: { state: string; version: number };
  };
  const reply = async (id: string, message: string, expectedVersion: number) =>
    (await request(app).post(`/api/v1/conversations/${id}/reply`).set(dashboard).send({ message, expectedVersion }).expect(201)).body as {
      message: { id: string };
      ownership: { version: number };
    };
  const handBack = (id: string, expectedVersion: number) =>
    request(app).post(`/api/v1/conversations/${id}/handback`).set(dashboard).send({ expectedVersion }).expect(200);
  const audits = () => repositories.auditEventRepository.items.filter((event) => event.eventType === "voice.operator_reply_spoken");

  return { session, callerSays, conversationId, detail, reply, handBack, audits };
};

describe("an operator's Inbox reply on a call", () => {
  // The dashboard tail's re-delivery of the spoken reply is Postgres behaviour, covered in
  // tests/integration/message-repository.integration.test.ts.
  it("is spoken on the caller's next turn in place of the waiting line, then marked spoken in history", async () => {
    const call = await callWorkspace();
    await call.callerSays("When do you open?");
    const id = await call.conversationId();
    const before = await call.detail(id);

    const sent = await call.reply(id, "Yes, **four** works for us.", before.ownership?.version ?? 0);
    const pending = await call.detail(id);
    expect(pending.ownership.state).toBe("human_owned");
    expect(pending.messages.find((message) => message.id === sent.message.id)).toMatchObject({
      source: "human_agent",
      content: "Yes, **four** works for us.",
      speech: { state: "pending" },
    });

    const turn = await call.callerSays("Can I come at four?");

    expect(turn).toEqual({ heard: "Yes, four works for us.\n", outcome: "continue" });
    const spoken = await call.detail(id);
    expect(spoken.messages.find((message) => message.id === sent.message.id)?.speech).toEqual({ state: "spoken", spokenAt: expect.any(String) });
    expect(spoken.messages.filter((message) => message.content === "Can I come at four?")).toHaveLength(1);
    expect(call.audits()).toEqual([expect.objectContaining({
      workspaceId: call.session.workspaceId,
      eventStatus: "success",
      metadata: { conversationId: id, messageIds: [sent.message.id] },
    })]);

    // Spoken once: the next turn hears chat again, which stays quiet once a teammate has written.
    expect(await call.callerSays("Great, thanks.")).toEqual({ heard: "", outcome: "continue" });
    expect(call.audits()).toHaveLength(1);
  });

  it("is spoken ahead of the agent's answer when the teammate hands the call back before the caller speaks", async () => {
    const call = await callWorkspace();
    await call.callerSays("When do you open?");
    const id = await call.conversationId();
    const sent = await call.reply(id, "Four works.", (await call.detail(id)).ownership?.version ?? 0);
    await call.handBack(id, sent.ownership.version);

    const turn = await call.callerSays("And when do you open on Sundays?");

    expect(turn.heard.startsWith("Four works.\n")).toBe(true);
    expect(turn.heard.length).toBeGreaterThan("Four works.\n".length);
    const after = await call.detail(id);
    expect(after.ownership.state).not.toBe("human_owned");
    expect(after.messages.find((message) => message.id === sent.message.id)?.speech?.state).toBe("spoken");
  });
});
