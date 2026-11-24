import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { operationPermissionRequirements } from "../../src/app/http/openapi/operationPermissionRequirements.js";
import type { CopilotToolInvocationContext } from "../../src/modules/operatorCopilot/contracts.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

const choice = (key: string, label: string) => ({ key, label, description: null, archived: false });

const seedWorkspace = async (email: string) => {
  const { app, dependencies, repositories } = createTestApp();
  const issued = await issueTestToken(app, email);
  const bearer = { Authorization: `Bearer ${issued.token}` };
  const session = adminSessionHeaders(issued);
  const userId = (await repositories.userRepository.findByEmail(email))!.id;
  const createAttribute = async (body: Record<string, unknown>): Promise<string> => (await request(app)
    .post("/api/v1/context-variables")
    .set(bearer)
    .send({ trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", ...body })
    .expect(201)).body.contextVariable.id as string;
  const topicId = await createAttribute({ name: "topic", valueType: "enum", options: [choice("billing", "Billing"), choice("shipping", "Shipping")] });
  const careNeedId = await createAttribute({ name: "care_need", valueType: "enum", sensitivity: "sensitive", options: [choice("dental", "Dental")] });
  await createAttribute({ name: "plan", valueType: "string" });
  const conversationId = (await request(app)
    .post("/api/v1/assistant/chat")
    .set(bearer)
    .send({ message: "Why was I charged twice?", stream: false })
    .expect(200)).body.conversationId as string;
  const agentId = (await dependencies.agentService.resolve(issued.workspaceId)).id;
  const classify = (variableId: string) => request(app)
    .put(`/api/v1/agents/${agentId}/context-variables/${variableId}`)
    .set(bearer)
    .send({ source: "classified", surfacing: "on_reference" })
    .expect(200);
  return { app, dependencies, repositories, issued, bearer, session, userId, conversationId, topicId, careNeedId, classify };
};

type Seeded = Awaited<ReturnType<typeof seedWorkspace>>;

const attributePath = (conversationId: string, name: string) => `/api/v1/history/chat/${conversationId}/attributes/${name}`;
const setAttribute = (h: Seeded, name: string, value: unknown, conversationId = h.conversationId) =>
  request(h.app).put(attributePath(conversationId, name)).set(h.session).send({ value });
const resetAttribute = (h: Seeded, name: string, conversationId = h.conversationId) =>
  request(h.app).delete(attributePath(conversationId, name)).set(h.session);
const detail = async (h: Seeded, headers: Record<string, string> = h.session) =>
  (await request(h.app).get(`/api/v1/history/chat/${h.conversationId}`).set(headers).expect(200)).body as {
    attributes: Array<Record<string, unknown>>;
    attributesEditable?: boolean;
  };
const editAudits = (h: Seeded) =>
  h.repositories.auditEventRepository.items.filter((event) => event.eventType.startsWith("conversation_attribute."));

describe("a teammate sets and resets a conversation's attribute from the Inbox (#1884)", () => {
  it("sets a Choice option as the signed-in teammate, and the conversation reads it back", async () => {
    const h = await seedWorkspace("attribute-edits-set@example.com");

    const set = await setAttribute(h, "topic", "shipping").expect(200);

    const written = {
      name: "topic",
      valueType: "enum",
      value: "shipping",
      option: { label: "Shipping", archived: false },
      redacted: false,
      scope: "conversation",
      writtenBy: { kind: "operator", ref: h.userId },
      updatedAt: expect.any(String),
      classified: false,
    };
    expect(set.body).toEqual({ attribute: written, classificationQueued: false });
    expect((await detail(h)).attributes).toEqual([written]);
  });

  it("records a content-free audit event for each edit: the ids, the action and the teammate", async () => {
    const h = await seedWorkspace("attribute-edits-audit@example.com");

    await setAttribute(h, "topic", "billing").expect(200);
    await resetAttribute(h, "topic").expect(200);

    expect(editAudits(h).map((event) => ({ eventType: event.eventType, metadata: event.metadata }))).toEqual([
      { eventType: "conversation_attribute.set", metadata: { actorUserId: h.userId, surface: "inbox", conversationId: h.conversationId, variableId: h.topicId } },
      { eventType: "conversation_attribute.reset", metadata: { actorUserId: h.userId, surface: "inbox", conversationId: h.conversationId, variableId: h.topicId } },
    ]);
    expect(JSON.stringify(editAudits(h))).not.toContain("billing");
  });

  it("keeps an API-written option as the team's when a teammate sets it, and a repeated set changes and audits nothing", async () => {
    const h = await seedWorkspace("attribute-edits-pin@example.com");
    await request(h.app)
      .put(`/api/v1/context-variables/${h.topicId}/values`)
      .set(h.bearer)
      .send({ scope: { type: "conversation", id: h.conversationId }, data: "billing" })
      .expect(200);

    const pinned = await setAttribute(h, "topic", "billing").expect(200);
    const repeated = await setAttribute(h, "topic", "billing").expect(200);

    expect(pinned.body.attribute).toMatchObject({ value: "billing", writtenBy: { kind: "operator", ref: h.userId } });
    expect(repeated.body).toEqual(pinned.body);
    expect(editAudits(h).map((event) => event.eventType)).toEqual(["conversation_attribute.set"]);
  });

  it("hands a classified attribute back to the AI on reset, and resets nothing the second time", async () => {
    const h = await seedWorkspace("attribute-edits-reset-classified@example.com");
    await h.classify(h.topicId);
    await setAttribute(h, "topic", "billing").expect(200);

    const reset = await resetAttribute(h, "topic").expect(200);
    const again = await resetAttribute(h, "topic").expect(200);

    expect(reset.body).toEqual({ attribute: null, classificationQueued: true });
    expect(again.body).toEqual({ attribute: null, classificationQueued: false });
    expect((await detail(h)).attributes).toEqual([]);
    expect(editAudits(h).map((event) => event.eventType)).toEqual(["conversation_attribute.set", "conversation_attribute.reset"]);
  });

  it("clears an attribute nothing classifies without asking the AI", async () => {
    const h = await seedWorkspace("attribute-edits-clear@example.com");
    await setAttribute(h, "topic", "billing").expect(200);

    const reset = await resetAttribute(h, "topic").expect(200);

    expect(reset.body).toEqual({ attribute: null, classificationQueued: false });
  });

  it("says on the conversation detail that the signed-in teammate may edit its attributes, and which ones the AI fills", async () => {
    const h = await seedWorkspace("attribute-edits-detail@example.com");
    await h.classify(h.topicId);
    await setAttribute(h, "topic", "billing").expect(200);

    const read = await detail(h);
    const machine = await detail(h, h.bearer);

    expect(read.attributesEditable).toBe(true);
    expect(read.attributes).toEqual([expect.objectContaining({ name: "topic", classified: true })]);
    expect(machine).not.toHaveProperty("attributesEditable");
  });

  it.each([
    ["a Private attribute", "care_need", "dental", 400, { code: "attribute_not_editable", details: { reason: "private" } }],
    ["one that is not a Choice", "plan", "pro", 400, { code: "attribute_not_editable", details: { reason: "not_choice" } }],
    ["an attribute nobody defined", "urgency", "high", 404, { message: "No attribute is named urgency" }],
  ])("refuses %s on both routes", async (_case, name, value, status, error) => {
    const h = await seedWorkspace(`attribute-edits-refused-${name}@example.com`);

    expect((await setAttribute(h, name, value).expect(status)).body.error).toMatchObject(error);
    expect((await resetAttribute(h, name).expect(status)).body.error).toMatchObject(error);
    expect(editAudits(h)).toEqual([]);
  });

  it("refuses an option the attribute lacks, naming its option keys", async () => {
    const h = await seedWorkspace("attribute-edits-wrong-option@example.com");

    const refused = await setAttribute(h, "topic", "Billing").expect(400);

    expect(refused.body.error.message).toBe("topic has no active option Billing; its option keys are billing, shipping");
    expect((await detail(h)).attributes).toEqual([]);
  });

  it("refuses a body that is not one option key", async () => {
    const h = await seedWorkspace("attribute-edits-body@example.com");

    await setAttribute(h, "topic", 7).expect(400);
    await request(h.app).put(attributePath(h.conversationId, "topic")).set(h.session).send({ value: "billing", scope: "session" }).expect(400);
  });

  it("refuses a conversation the workspace doesn't have", async () => {
    const h = await seedWorkspace("attribute-edits-unknown-conversation@example.com");
    const elsewhere = "99999999-9999-4999-8999-999999999999";

    await setAttribute(h, "topic", "billing", elsewhere).expect(404);
    await resetAttribute(h, "topic", elsewhere).expect(404);
  });

  it("refuses a machine credential, since the teammate signed in is the value's writer", async () => {
    const h = await seedWorkspace("attribute-edits-bearer@example.com");

    await request(h.app).put(attributePath(h.conversationId, "topic")).set(h.bearer).send({ value: "billing" }).expect(401);
    await request(h.app).delete(attributePath(h.conversationId, "topic")).set(h.bearer).expect(401);
    expect((await detail(h)).attributes).toEqual([]);
  });

  it("refuses a teammate without the conversation takeover permission", async () => {
    const h = await seedWorkspace("attribute-edits-no-takeover@example.com");
    vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
      if (permission === "workspace.history.read") return null;
      throw forbidden("You do not have permission to perform this action");
    });

    await setAttribute(h, "topic", "billing").expect(403);
    await resetAttribute(h, "topic").expect(403);
    expect(editAudits(h)).toEqual([]);
  });

  it("declares both routes session-only under the takeover permission, and documents them", () => {
    for (const method of ["PUT", "DELETE"] as const) {
      expect(apiPrincipalRoutePolicy[`${method} /api/v1/history/chat/:conversationId/attributes/:name`]).toEqual({
        permission: "workspace.conversation.takeover",
        allowedPrincipalKinds: ["session_user"],
        sessionOnly: true,
      });
    }
    expect(operationPermissionRequirements.setHistoryConversationAttribute).toEqual(["workspace.conversation.takeover"]);
    expect(operationPermissionRequirements.resetHistoryConversationAttribute).toEqual(["workspace.conversation.takeover"]);
    const path = createOpenApiDocument().paths?.["/api/v1/history/chat/{conversationId}/attributes/{name}"];
    expect(path?.put?.operationId).toBe("setHistoryConversationAttribute");
    expect(path?.delete?.operationId).toBe("resetHistoryConversationAttribute");
  });
});

describe("Ray and operator MCP set and reset a conversation's attribute through the same edit (#1884)", () => {
  const invoke = async (h: Seeded, surface: CopilotToolInvocationContext["surface"], tool: string, input: Record<string, unknown>) => {
    const descriptor = h.dependencies.copilotToolCatalog.find((candidate) => candidate.name === tool);
    if (!descriptor) throw new Error(`No ${tool} tool`);
    const context = {
      workspaceId: h.issued.workspaceId,
      accountId: h.issued.accountId,
      operatorUserId: h.userId,
      surface,
      currentAuthorization: { hasAllPermissions: async () => true },
      pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
    } as unknown as CopilotToolInvocationContext;
    return descriptor.createTool(context).invoke(input, {} as never) as Promise<Record<string, unknown>>;
  };
  const transcriptAttributes = async (h: Seeded) =>
    ((await invoke(h, "mcp", "conversation_transcript", { conversationId: h.conversationId })) as { transcript: { attributes: unknown[] } }).transcript.attributes;

  it("sets an option over MCP, which conversation_transcript then reads as the operator's", async () => {
    const h = await seedWorkspace("attribute-edits-mcp-set@example.com");

    const set = await invoke(h, "mcp", "set_conversation_attribute", { conversationId: h.conversationId, name: "topic", value: "billing" });

    expect(set).toMatchObject({ attribute: { name: "topic", value: "billing", writtenBy: { kind: "operator", ref: h.userId } }, classificationQueued: false });
    expect(await transcriptAttributes(h)).toEqual([expect.objectContaining({
      name: "topic",
      value: "billing",
      option: { label: "Billing", archived: false },
      writtenBy: { kind: "operator", ref: h.userId },
      classified: false,
    })]);
    expect(editAudits(h).map((event) => event.metadata)).toEqual([expect.objectContaining({ surface: "mcp" })]);
  });

  it("resets from Ray, which hands a classified attribute back to the AI, and the transcript reads none", async () => {
    const h = await seedWorkspace("attribute-edits-ray-reset@example.com");
    await h.classify(h.topicId);
    await invoke(h, "dashboard", "set_conversation_attribute", { conversationId: h.conversationId, name: "topic", value: "shipping" });

    const reset = await invoke(h, "dashboard", "reset_conversation_attribute", { conversationId: h.conversationId, name: "topic" });

    expect(reset).toMatchObject({ attribute: null, classificationQueued: true });
    expect(await transcriptAttributes(h)).toEqual([]);
    expect(editAudits(h).map((event) => event.metadata)).toEqual([
      expect.objectContaining({ surface: "ray" }),
      expect.objectContaining({ surface: "ray" }),
    ]);
  });

  it("passes the service's refusal through to the caller", async () => {
    const h = await seedWorkspace("attribute-edits-mcp-refused@example.com");

    await expect(invoke(h, "mcp", "set_conversation_attribute", { conversationId: h.conversationId, name: "care_need", value: "dental" }))
      .rejects.toMatchObject({ statusCode: 400, code: "attribute_not_editable" });
    await expect(invoke(h, "mcp", "set_conversation_attribute", { conversationId: h.conversationId, name: "topic", value: "returns" }))
      .rejects.toMatchObject({ statusCode: 400, message: "topic has no active option returns; its option keys are billing, shipping" });
  });
});
