import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const gateway: ChatGateway = {
  answer: async () => "We open at nine.",
  async *streamAnswer() {
    yield "We open at nine.";
  },
};

const voice = {
  enabled: true,
  bridgeLines: { en: { acknowledge: [], check: [] } },
  fallbackLine: { en: "Sorry, this is taking much longer than it should, could you ask me again?" },
};

describe("a call started from a page that showed the agent's privacy notice (#1545)", () => {
  it("records the version the page handed the call on the conversation its first turn starts", async () => {
    const { app, dependencies } = createTestApp({ chatGateway: gateway });
    const session = await issueTestSession(app, `voice-notice-${randomUUID()}@example.com`);
    const dashboard = adminSessionHeaders(session);
    const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
    const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
    const saved = await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({
      voice,
      branding: {
        hidePoweredBy: false,
        privacyPolicyUrl: null,
        privacyNotice: { en: { text: "We use your messages to answer you.", url: "https://example.com/privacy" } },
      },
    }).expect(200);
    const version = (saved.body.branding as { privacyNotice: { en: { version: string } } }).privacyNotice.en.version;
    const runtimeCredential = await dependencies.accessGrantService.issueGrant({
      agentId,
      workspaceId: session.workspaceId,
      principalKind: "agent-api",
      channel: "agent-api",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: new Date(Date.now() + 600_000),
    });
    const sessionKey = randomUUID();
    const turn = (content: string) => request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeCredential.token}`)
      .send({
        messages: [{ role: "user", content }],
        stream: false,
        elevenlabs_extra_body: { session_key: sessionKey, locale: "en", privacy_notice_version: version },
      })
      .expect(200);

    await turn("When do you open?");
    await turn("And on Sunday?");

    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const conversationId = (history.body.conversations as Array<{ id: string; channelContext?: { sessionKey?: string } | null }>)
      .find((item) => item.channelContext?.sessionKey === sessionKey)!.id;
    const detail = await request(app).get(`/api/v1/history/chat/${conversationId}`).set(dashboard).expect(200);
    expect(detail.body.privacyNoticeVersion).toBe(version);
  });
});
