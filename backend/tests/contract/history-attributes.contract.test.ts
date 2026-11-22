import request from "supertest";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

type TestApp = ReturnType<typeof createTestApp>["app"];

const createAttribute = async (app: TestApp, authorization: string, body: Record<string, unknown>): Promise<string> => {
  const response = await request(app)
    .post("/api/v1/context-variables")
    .set("Authorization", authorization)
    .send({ trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", ...body })
    .expect(201);
  return response.body.contextVariable.id as string;
};

const startConversation = async (app: TestApp, authorization: string, message: string): Promise<string> => {
  const response = await request(app)
    .post("/api/v1/assistant/chat")
    .set("Authorization", authorization)
    .send({ message, stream: false })
    .expect(200);
  return response.body.conversationId as string;
};

const setValue = (app: TestApp, authorization: string, variableId: string, conversationId: string, data: unknown) =>
  request(app)
    .put(`/api/v1/context-variables/${variableId}/values`)
    .set("Authorization", authorization)
    .send({ scope: { type: "conversation", id: conversationId }, data })
    .expect(200);

const choice = (key: string, label: string, archived = false) => ({ key, label, description: null, archived });

const seedWorkspace = async (email: string) => {
  const { app } = createTestApp();
  const { token } = await issueTestToken(app, email);
  const authorization = `Bearer ${token}`;
  const topicId = await createAttribute(app, authorization, {
    name: "topic",
    valueType: "enum",
    options: [choice("billing", "Billing"), choice("shipping", "Shipping")],
  });
  const careNeedId = await createAttribute(app, authorization, {
    name: "care_need",
    valueType: "enum",
    sensitivity: "sensitive",
    options: [choice("dental", "Dental")],
  });
  const planId = await createAttribute(app, authorization, { name: "plan", valueType: "string" });
  const billing = await startConversation(app, authorization, "Why was I charged twice?");
  const shipping = await startConversation(app, authorization, "Where is my parcel?");
  const unlabelled = await startConversation(app, authorization, "Hello");
  await setValue(app, authorization, topicId, billing, "billing");
  await setValue(app, authorization, careNeedId, billing, "dental");
  await setValue(app, authorization, planId, billing, "pro");
  await setValue(app, authorization, topicId, shipping, "shipping");
  // An option is archived after values name it; they keep naming it.
  await request(app)
    .patch(`/api/v1/context-variables/${topicId}`)
    .set("Authorization", authorization)
    .send({ options: [choice("billing", "Billing"), choice("shipping", "Shipping", true)] })
    .expect(200);
  return { app, authorization, conversations: { billing, shipping, unlabelled } };
};

describe("conversation attributes on the history routes", () => {
  it("reads a conversation's attributes with who set them, an archived option marked and a Private value redacted", async () => {
    const { app, authorization, conversations } = await seedWorkspace("history-attributes-detail@example.com");

    const billing = await request(app).get(`/api/v1/history/chat/${conversations.billing}`).set("Authorization", authorization).expect(200);
    const shipping = await request(app).get(`/api/v1/history/chat/${conversations.shipping}`).set("Authorization", authorization).expect(200);
    const unlabelled = await request(app).get(`/api/v1/history/chat/${conversations.unlabelled}`).set("Authorization", authorization).expect(200);

    expect(billing.body.attributes).toEqual([
      {
        name: "care_need",
        valueType: "enum",
        value: null,
        redacted: true,
        scope: "conversation",
        writtenBy: { kind: "api", ref: expect.any(String) },
        updatedAt: expect.any(String),
      },
      {
        name: "plan",
        valueType: "string",
        value: "pro",
        redacted: false,
        scope: "conversation",
        writtenBy: { kind: "api", ref: expect.any(String) },
        updatedAt: expect.any(String),
      },
      {
        name: "topic",
        valueType: "enum",
        value: "billing",
        option: { label: "Billing", archived: false },
        redacted: false,
        scope: "conversation",
        writtenBy: { kind: "api", ref: expect.any(String) },
        updatedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(billing.body.attributes)).not.toContain("dental");
    expect(shipping.body.attributes).toEqual([expect.objectContaining({ name: "topic", value: "shipping", option: { label: "Shipping", archived: true } })]);
    expect(unlabelled.body.attributes).toEqual([]);
  });

  it("narrows both history lists and the text search to the conversations whose own value is an option", async () => {
    const { app, authorization, conversations } = await seedWorkspace("history-attributes-filter@example.com");

    const items = await request(app)
      .get("/api/v1/history")
      .query({ attribute: "topic", attributeOption: "billing" })
      .set("Authorization", authorization)
      .expect(200);
    const archivedOption = await request(app)
      .get("/api/v1/history/chat")
      .query({ attribute: "topic", attributeOption: "shipping" })
      .set("Authorization", authorization)
      .expect(200);
    const searched = await request(app)
      .post("/api/v1/history/query")
      .set("Authorization", authorization)
      .send({ q: "charged", attribute: "topic", attributeOption: "shipping" })
      .expect(200);

    expect(items.body.items.map((item: { id: string }) => item.id)).toEqual([conversations.billing]);
    expect(items.body.total).toBe(1);
    expect(archivedOption.body.conversations.map((conversation: { id: string }) => conversation.id)).toEqual([conversations.shipping]);
    expect(searched.body.items).toEqual([]);
  });

  it.each([
    ["an attribute without an option", { attribute: "topic" }],
    ["an option without an attribute", { attributeOption: "billing" }],
    ["an attribute nobody defined", { attribute: "urgency", attributeOption: "high" }],
    ["one that is not a Choice", { attribute: "plan", attributeOption: "pro" }],
    ["a Private one, whose values a filter would reveal", { attribute: "care_need", attributeOption: "dental" }],
    ["an option the attribute does not have", { attribute: "topic", attributeOption: "returns" }],
  ])("refuses a filter on %s", async (_case, query) => {
    const { app, authorization } = await seedWorkspace(`history-attributes-refused-${Object.keys(query).join("-")}@example.com`);

    await request(app).get("/api/v1/history").query(query).set("Authorization", authorization).expect(400);
    await request(app).get("/api/v1/history/chat").query(query).set("Authorization", authorization).expect(400);
  });

  it("documents the attributes and the filter in the generated schema", () => {
    const document = createOpenApiDocument();
    const detail = document.components?.schemas?.ChatConversationDetail as { properties?: Record<string, unknown> };
    const publicDetail = document.components?.schemas?.PublicChatConversationDetail as { properties?: Record<string, unknown> };
    const parameterNames = (path: string) =>
      ((document.paths?.[path]?.get?.parameters ?? []) as Array<{ name: string }>).map((parameter) => parameter.name);
    const queryBody = document.paths?.["/api/v1/history/query"]?.post?.requestBody as {
      content: { "application/json": { schema: { properties: Record<string, unknown> } } };
    };

    expect(detail.properties).toHaveProperty("attributes");
    expect(publicDetail.properties).not.toHaveProperty("attributes");
    expect(parameterNames("/api/v1/history")).toEqual(expect.arrayContaining(["attribute", "attributeOption"]));
    expect(parameterNames("/api/v1/history/chat")).toEqual(expect.arrayContaining(["attribute", "attributeOption"]));
    expect(queryBody.content["application/json"].schema.properties).toHaveProperty("attributeOption");
  });
});
