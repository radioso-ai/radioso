import request from "supertest";
import { describe, expect, it } from "vitest";

import { createAgentToolCatalogComposition } from "../../src/app/composition/agentToolCatalog.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { adminSessionHeaders, createTestApp, issueTestSession, publishTestAgentBaseline } from "../support/testApp.js";

const bookTableDraft = (): RoutineDefinitionDraftInput => ({
  name: "Book a table",
  enabled: true,
  activation: {
    triggerDescription: "When the visitor wants to book a table.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  exposure: { enabled: true, toolName: "book_table", description: "Book a table for a date and party size." },
  slots: [{ stableSlotId: "slot_date", key: "date", type: "date", required: true, description: "The date", ordinal: 0 }],
  steps: [{ stableStepId: "ask_date", kind: "chat", instruction: "Ask for {{slot.date}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask_date", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the booking.", ordinal: 1 }],
});

const createDiscoveryApp = (envOverrides: Record<string, unknown> = {}) => createTestApp({
  // The production reader composes the catalog over the immutable release store, which is
  // what a public document must describe.
  agentToolCatalog: createAgentToolCatalogComposition,
  envOverrides,
});

/** A published, card-enabled, walk-in-open agent with one exposed routine. */
const publishDiscoverableAgent = async (ctx: ReturnType<typeof createDiscoveryApp>) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const updated = await request(ctx.app)
    .put(`/api/v1/agents/${agent.id}`)
    .set(adminSessionHeaders(session))
    .send({
      agentCardEnabled: true,
      publicAgentAccessEnabled: true,
      publicDescription: "Answers questions about bookings and retreats.",
    })
    .expect(200);
  const draft = await ctx.dependencies.routineDefinitionService.createDraft(session.workspaceId, agent.id, bookTableDraft());
  await publishTestAgentBaseline(ctx.app, { workspaceId: session.workspaceId, agentId: agent.id, routines: [draft.routine] });
  return { session, agent, publicId: updated.body.publicId as string };
};

const cardPaths = (publicId: string) => [
  `/.well-known/agent-card/${publicId}.json`,
  `/.well-known/mcp/server-card/${publicId}.json`,
  `/.well-known/ai-catalog/${publicId}.json`,
];

describe("agent discovery documents", () => {
  it("serves all three documents for a published, card-enabled agent, cacheable and revalidatable", async () => {
    const ctx = createDiscoveryApp();
    const { publicId } = await publishDiscoverableAgent(ctx);

    for (const path of cardPaths(publicId)) {
      const response = await request(ctx.app).get(path).expect(200);

      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.headers.etag).toMatch(/^W\//u);

      const revalidated = await request(ctx.app)
        .get(path)
        .set("If-None-Match", String(response.headers.etag))
        .expect(304);
      expect(revalidated.text).toBe("");
    }
  });

  it("describes the agent, its endpoint, and its exposed routine without leaking an internal identifier", async () => {
    const ctx = createDiscoveryApp();
    const { session, agent, publicId } = await publishDiscoverableAgent(ctx);

    const card = await request(ctx.app).get(`/.well-known/agent-card/${publicId}.json`).expect(200);
    expect(card.body).toMatchObject({
      name: agent.name,
      description: "Answers questions about bookings and retreats.",
      url: `https://mcp.radioso.test/mcp/a/${publicId}`,
      documentationUrl: "https://docs.radioso.test/guides/agent-converse",
    });
    expect(card.body.skills.map((skill: { id: string }) => skill.id)).toEqual(["book_table"]);
    expect(card.body.security).toEqual([{}, { bearer: [] }]);

    const embedToken = (await ctx.repositories.agentRepository.findByIdAndWorkspaceId(agent.id, session.workspaceId))
      ?.surfaceSettings.websiteEmbed.token;
    for (const path of cardPaths(publicId)) {
      const document = JSON.stringify((await request(ctx.app).get(path).expect(200)).body);
      expect(document).not.toContain(session.workspaceId);
      expect(document).not.toContain(agent.id);
      expect(document).not.toContain(String(embedToken));
    }
  });

  it("advertises bearer only while walk-in access is closed", async () => {
    const ctx = createDiscoveryApp();
    const { session, agent, publicId } = await publishDiscoverableAgent(ctx);
    await request(ctx.app)
      .put(`/api/v1/agents/${agent.id}`)
      .set(adminSessionHeaders(session))
      .send({ publicAgentAccessEnabled: false })
      .expect(200);

    const card = await request(ctx.app).get(`/.well-known/agent-card/${publicId}.json`).expect(200);

    expect(card.body.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(card.body.securitySchemes)).toEqual(["bearer"]);
  });

  it("answers unknown, card-disabled, unpublished, and deleted ids with the same 404", async () => {
    const ctx = createDiscoveryApp();
    const { session, agent, publicId } = await publishDiscoverableAgent(ctx);

    const unknown = await request(ctx.app).get(`/.well-known/agent-card/ag_UnknownPublicIdent00.json`).expect(404);

    const unpublished = await request(ctx.app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({ name: "Second desk" })
      .expect(201);
    const unpublishedPublicId = (await request(ctx.app)
      .put(`/api/v1/agents/${unpublished.body.id}`)
      .set(adminSessionHeaders(session))
      .send({ agentCardEnabled: true })
      .expect(200)).body.publicId as string;
    const unpublishedResponse = await request(ctx.app)
      .get(`/.well-known/agent-card/${unpublishedPublicId}.json`)
      .expect(404);

    await request(ctx.app)
      .put(`/api/v1/agents/${agent.id}`)
      .set(adminSessionHeaders(session))
      .send({ agentCardEnabled: false, publicAgentAccessEnabled: false })
      .expect(200);
    const disabled = await request(ctx.app).get(`/.well-known/agent-card/${publicId}.json`).expect(404);

    await ctx.repositories.agentRepository.deleteByIdAndWorkspaceId(unpublished.body.id, session.workspaceId);
    const deleted = await request(ctx.app).get(`/.well-known/agent-card/${unpublishedPublicId}.json`).expect(404);

    for (const response of [unpublishedResponse, disabled, deleted]) {
      expect(response.body).toEqual(unknown.body);
    }
  });

  it("refuses to publish a card rather than name an endpoint it has not been configured with", async () => {
    const ctx = createDiscoveryApp({ PUBLIC_MCP_CONVERSE_URL: undefined });
    const { publicId } = await publishDiscoverableAgent(ctx);

    await request(ctx.app).get(`/.well-known/agent-card/${publicId}.json`).expect(500);
  });
});
