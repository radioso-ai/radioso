import { randomUUID } from "node:crypto";

import request from "supertest";

import type { z } from "zod";

import type { agentVoiceSettingsInputSchema } from "../../src/modules/agents/voiceSettings.js";
import { adminSessionHeaders, issueTestSession, type createTestApp } from "./testApp.js";

type TestApp = Pick<ReturnType<typeof createTestApp>, "app" | "dependencies">;

/** The agent settings a voice test writes, as the dashboard sends them on `PUT /api/v1/agents/:agentId`. */
interface VoiceAgentSettings {
  assistantDefaultLocale?: string;
  voice?: z.input<typeof agentVoiceSettingsInputSchema>;
}

/**
 * A voice runtime's way in on a test app: an operator signs up, which publishes the workspace's
 * default agent, writes the agent's settings the way the dashboard does when the test gives some,
 * and issues the `agent-api` credential the runtime posts its turns with.
 */
export const openVoiceRuntime = async (
  { app, dependencies }: TestApp,
  options: { emailPrefix: string; agentSettings?: VoiceAgentSettings },
) => {
  const session = await issueTestSession(app, `${options.emailPrefix}-${randomUUID()}@example.com`);
  const dashboard = adminSessionHeaders(session);
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  if (options.agentSettings) {
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send(options.agentSettings).expect(200);
  }
  const runtimeCredential = await dependencies.accessGrantService.issueGrant({
    agentId,
    workspaceId: session.workspaceId,
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 600_000),
  });
  return { session, dashboard, agentId, runtimeToken: runtimeCredential.token };
};
