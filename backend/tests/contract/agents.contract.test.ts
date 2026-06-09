import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../src/modules/documents/contracts/index.js";
import { defaultAnswerDirectives } from "../../src/modules/directives/public.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { RESPONSE_INTENT, REWRITE_TURN_KIND } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

const parseSseData = (body: string, eventName: string): unknown[] =>
  body
    .split("\n\n")
    .filter((block) => block.includes(`event: ${eventName}\n`))
    .map((block) => {
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) {
        throw new Error(`Missing data line for ${eventName}`);
      }
      return JSON.parse(dataLine.slice("data: ".length));
    });

const validRoutineDraft = (overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
  name: "support-intake",
  activation: {
    triggerDescription: "When the user asks for support intake",
    gateRef: null,
    priority: 10,
  },
  slots: [{
    stableSlotId: "slot_topic",
    key: "topic",
    type: "text",
    required: true,
    description: "The support topic",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "step_collect_topic",
    kind: "chat",
    instruction: "Ask for {{slot.topic}}.",
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "terminal_complete",
    guardKind: "always",
    guardText: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: "Complete intake for {{slot.topic}}.",
    actionType: null,
    ordinal: 1,
  }],
  ...overrides,
});

const invalidRoutineDraft = (): RoutineDefinitionDraftInput =>
  validRoutineDraft({
    name: "broken-intake",
    slots: [{
      stableSlotId: "slot_unused",
      key: "unused",
      type: "text",
      required: true,
      description: null,
      ordinal: 0,
    }],
    steps: [{
      stableStepId: "step_collect_topic",
      kind: "chat",
      instruction: "Ask for {{slot.topic}}.",
      toolRef: null,
      ordinal: 0,
      metadata: {},
    }],
    transitions: [{
      fromStep: "step_collect_topic",
      toRef: "missing_step",
      guardKind: "always",
      guardText: null,
      ordinal: 0,
    }],
  });

describe("agents contract", () => {
  it("creates a default agent and preserves omitted agentId chat compatibility", async () => {
    const chatGateway: ChatGateway = {
      async answer({ query }) {
        return `answer:${query}`;
      },
      async *streamAnswer({ query }) {
        yield `answer:${query}`;
      },
    };
    const { app } = createTestApp({ chatGateway });
    const { token } = await issueTestToken(app, "agents-default@example.com");
    const authorization = `Bearer ${token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);

    expect(list.body.agents).toHaveLength(1);
    expect(list.body.agents[0]).toMatchObject({
      id: expect.any(String),
      isDefault: true,
      retrievalEnabled: true,
      sourceScope: {
        mode: "all",
      },
      surfaceSettings: {
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false },
      },
    });

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "hello", stream: false })
      .expect(200);

    expect(chat.body).toMatchObject({
      agentId: list.body.agents[0].id,
      agentName: list.body.agents[0].name,
      answer: expect.any(String),
    });
  });

  it("persists selected source scope and validates source ownership", async () => {
    const { app } = createTestApp();
    const first = await issueTestToken(app, "agents-source-scope-first@example.com");
    const second = await issueTestToken(app, "agents-source-scope-second@example.com");
    const firstAuthorization = `Bearer ${first.token}`;
    const secondAuthorization = `Bearer ${second.token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", firstAuthorization)
      .send({
        title: "First source doc",
        content: "First source body",
        source: {
          kind: "website",
          url: "https://first.example/docs",
        },
      })
      .expect(202);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", secondAuthorization)
      .send({
        title: "Second source doc",
        content: "Second source body",
        source: {
          kind: "website",
          url: "https://second.example/docs",
        },
      })
      .expect(202);

    const firstSources = await request(app)
      .get("/api/v1/document/sources")
      .set("Authorization", firstAuthorization)
      .expect(200);
    const secondSources = await request(app)
      .get("/api/v1/document/sources")
      .set("Authorization", secondAuthorization)
      .expect(200);
    const firstSourceId = firstSources.body.sources[0].id as string;
    const secondSourceId = secondSources.body.sources[0].id as string;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", firstAuthorization)
      .send({
        name: "Scoped agent",
        sourceScope: {
          mode: "selected",
          sourceIds: [firstSourceId],
        },
      })
      .expect(201);

    expect(agent.body.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [firstSourceId],
    });

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}`)
      .set("Authorization", firstAuthorization)
      .send({
        sourceScope: {
          mode: "selected",
          sourceIds: [secondSourceId],
        },
      })
      .expect(400);
  });

  it("accepts and returns per-agent skill settings", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-skill-settings@example.com");
    const authorization = `Bearer ${token}`;

    const created = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Retrieval tuned",
        skillSettings: {
          "retrieval.answer": {
            queryRewriteEnabled: false,
            vectorTopK: 7,
          },
          "custom.skill": {
            enabled: true,
          },
        },
      })
      .expect(201);

    expect(created.body.skillSettings).toEqual({
      "retrieval.answer": {
        queryRewriteEnabled: false,
        vectorTopK: 7,
      },
      "custom.skill": {
        enabled: true,
      },
    });

    const updated = await request(app)
      .put(`/api/v1/agents/${created.body.id}`)
      .set("Authorization", authorization)
      .send({
        skillSettings: {
          "retrieval.answer": {
            rerankEnabled: true,
          },
        },
      })
      .expect(200);

    expect(updated.body.skillSettings).toEqual({
      "retrieval.answer": {
        rerankEnabled: true,
      },
    });

    const fetched = await request(app)
      .get(`/api/v1/agents/${created.body.id}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(fetched.body.skillSettings).toEqual(updated.body.skillSettings);
  });

  it("rejects invalid per-agent retrieval skill settings at the write boundary", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-invalid-skill-settings@example.com");
    const authorization = `Bearer ${token}`;

    const response = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Invalid retrieval tuned",
        skillSettings: {
          "retrieval.answer": {
            vectorTopK: 0,
          },
        },
      })
      .expect(400);

    expect(response.body.error.message).toMatch(/vectorTopK/);
  });

  it("rejects per-agent match-turn metadata rules without a trigger instruction", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-invalid-match-turn-rule@example.com");
    const authorization = `Bearer ${token}`;

    const response = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Invalid match turn rule",
        skillSettings: {
          "retrieval.answer": {
            metadataRules: [
              {
                id: "audience-rule",
                field: "audience",
                valueType: "string",
                operator: "equals",
                value: "partner",
                conditions: [
                  {
                    id: "audience-condition",
                    field: "audience",
                    valueType: "string",
                    operator: "equals",
                    value: "partner",
                  },
                ],
                effect: "filter",
                enabled: true,
                triggerMode: "match_turn",
              },
            ],
          },
        },
      })
      .expect(400);

    expect(response.body.error.message).toMatch(/triggerInstruction/);
  });

  it("accepts per-agent match-turn metadata rules with a trigger instruction", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-valid-match-turn-rule@example.com");
    const authorization = `Bearer ${token}`;

    const response = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Valid match turn rule",
        skillSettings: {
          "retrieval.answer": {
            metadataRules: [
              {
                id: "audience-rule",
                field: "audience",
                valueType: "string",
                operator: "equals",
                value: "partner",
                conditions: [
                  {
                    id: "audience-condition",
                    field: "audience",
                    valueType: "string",
                    operator: "equals",
                    value: "partner",
                  },
                ],
                effect: "filter",
                enabled: true,
                triggerMode: "match_turn",
                triggerInstruction: "Use for partner-specific questions",
              },
            ],
          },
        },
      })
      .expect(201);

    expect(response.body.skillSettings["retrieval.answer"].metadataRules[0]).toMatchObject({
      id: "audience-rule",
      triggerMode: "match_turn",
      triggerInstruction: "Use for partner-specific questions",
    });
  });

  it("persists manually added documents in selected source scope", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-manual-source-scope@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Manual policy",
        content: "Manual document body",
      })
      .expect(202);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Website policy",
        content: "Website document body",
        source: {
          kind: "website",
          url: "https://manual-scope.example/docs",
        },
      })
      .expect(202);

    const sources = await request(app)
      .get("/api/v1/document/sources")
      .set("Authorization", authorization)
      .expect(200);
    const websiteSourceId = sources.body.sources.find(
      (source: { externalId?: string }) => source.externalId === "https://manual-scope.example/docs",
    )?.id;
    expect(websiteSourceId).toEqual(expect.any(String));

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Manual scoped",
        sourceScope: {
          mode: "selected",
          sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID],
        },
      })
      .expect(201);

    expect(agent.body.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID],
    });

    const manualOnly = await request(app)
      .get(`/api/v1/agents/${agent.body.id}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(manualOnly.body.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID],
    });

    const mixed = await request(app)
      .put(`/api/v1/agents/${agent.body.id}`)
      .set("Authorization", authorization)
      .send({
        sourceScope: {
          mode: "selected",
          sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, websiteSourceId],
        },
      })
      .expect(200);

    expect(mixed.body.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, websiteSourceId],
    });

    const persistedMixed = await request(app)
      .get(`/api/v1/agents/${agent.body.id}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(persistedMixed.body.sourceScope).toEqual({
      mode: "selected",
      sourceIds: [MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, websiteSourceId],
    });
  });

  it("persists branding privacy policy URL through agent update, GET, and public chat session", async () => {
    const privacyPolicyUrl = "https://example.com/privacy";
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agents-branding-round-trip@example.com");
    const authorization = `Bearer ${session.token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const agentId = list.body.agents[0].id as string;

    const updated = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({
        branding: {
          hidePoweredBy: false,
          privacyPolicyUrl,
        },
      })
      .expect(200);
    expect(updated.body.branding).toEqual({
      hidePoweredBy: false,
      privacyPolicyUrl,
    });

    const reloaded = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .expect(200);
    expect(reloaded.body.branding).toEqual({
      hidePoweredBy: false,
      privacyPolicyUrl,
    });

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true })
      .expect(200);
    const anonymousChatToken = new URL(settings.body.anonymousChatUrl).pathname.split("/").at(-1);
    expect(anonymousChatToken).toBeTruthy();

    const publicSession = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" })
      .expect(200);
    expect(publicSession.body.branding).toEqual({
      hidePoweredBy: false,
      privacyPolicyUrl,
    });

    const historyList = await request(app)
      .get(`/api/v1/public/chat/${anonymousChatToken}?limit=1`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .expect(200);
    expect(historyList.body.branding).toEqual({
      hidePoweredBy: false,
      privacyPolicyUrl,
    });
  });

  it("limits assistant retrieval to the selected agent sources", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-source-retrieval@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Alpha Guide",
        content: "Alpha meditation retreat details.",
        source: {
          kind: "website",
          url: "https://alpha.example/docs",
        },
      })
      .expect(202);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Beta Guide",
        content: "Beta pricing and support details.",
        source: {
          kind: "website",
          url: "https://beta.example/docs",
        },
      })
      .expect(202);

    const sources = await request(app)
      .get("/api/v1/document/sources")
      .set("Authorization", authorization)
      .expect(200);
    const alphaSourceId = sources.body.sources.find((source: { externalId: string }) => source.externalId === "https://alpha.example/docs")?.id;
    const betaSourceId = sources.body.sources.find((source: { externalId: string }) => source.externalId === "https://beta.example/docs")?.id;
    expect(alphaSourceId).toEqual(expect.any(String));
    expect(betaSourceId).toEqual(expect.any(String));

    const scopedAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Beta scoped",
        sourceScope: {
          mode: "selected",
          sourceIds: [betaSourceId],
        },
      })
      .expect(201);

    const scopedChat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ agentId: scopedAgent.body.id, message: "Alpha meditation", stream: false, includeDebug: true })
      .expect(200);

    expect(scopedChat.body.debug.activitySummary.candidateCounts.final).toBe(0);
    expect(scopedChat.body.citations ?? []).toEqual([]);

    await request(app)
      .put(`/api/v1/agents/${scopedAgent.body.id}`)
      .set("Authorization", authorization)
      .send({
        sourceScope: {
          mode: "selected",
          sourceIds: [alphaSourceId],
        },
      })
      .expect(200);

    const allowedChat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ agentId: scopedAgent.body.id, message: "Alpha meditation", stream: false, includeDebug: true })
      .expect(200);

    expect(allowedChat.body.debug.activitySummary.candidateCounts.final).toBeGreaterThan(0);
    expect(allowedChat.body.answer).toContain("Alpha meditation retreat details.");
  });

  it("routes explicit agents and rejects agents from another workspace", async () => {
    const { app } = createTestApp({
      lexicalSearch: {
        async search() {
          throw new Error("direct-only agent should not invoke retrieval search");
        },
      },
    });
    const first = await issueTestToken(app, "agents-first@example.com");
    const second = await issueTestToken(app, "agents-second@example.com");
    const firstAuthorization = `Bearer ${first.token}`;
    const secondAuthorization = `Bearer ${second.token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", firstAuthorization)
      .send({
        name: "Direct agent",
        customInstruction: "Answer without retrieval.",
        retrievalEnabled: false,
      })
      .expect(201);

    expect(agent.body).toMatchObject({
      retrievalEnabled: false,
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
        },
      },
    });

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", firstAuthorization)
      .send({ agentId: agent.body.id, message: "hello direct", stream: false, includeDebug: true })
      .expect(200);

    expect(chat.body).toMatchObject({
      agentId: agent.body.id,
      agentName: "Direct agent",
      debug: {
        activitySummary: expect.objectContaining({
          retrievalSkipped: true,
        }),
      },
    });
    expect(chat.body.citations ?? []).toEqual([]);
    expect(chat.body.debug.activitySummary.candidateCounts).toMatchObject({
      semantic: 0,
      lexical: 0,
      final: 0,
    });

    await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", secondAuthorization)
      .send({ agentId: agent.body.id, message: "cross workspace", stream: false })
      .expect(404);
  });

  it("manages authored directives on an agent and returns advisory coherence verdicts", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-directives-crud@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Directive authoring" })
      .expect(201);

    const create = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/directives`)
      .set("Authorization", authorization)
      .send({
        name: "operator-formality",
        condition: { kind: "always" },
        action: "Use a formal register.",
      })
      .expect(201);

    expect(create.body).toMatchObject({
      directive: {
        id: expect.any(String),
        agentId: agent.body.id,
        name: "operator-formality",
        condition: { kind: "always" },
        action: "Use a formal register.",
        priority: null,
        requiredCapabilities: [],
        routes: [],
      },
      coherence: {
        coherent: true,
        conflicts: [],
        rationale: expect.any(String),
      },
    });

    const list = await request(app)
      .get(`/api/v1/agents/${agent.body.id}/directives`)
      .set("Authorization", authorization)
      .expect(200);

    expect(list.body.directives).toHaveLength(1);
    expect(list.body.directives[0]).toMatchObject({
      id: create.body.directive.id,
      name: "operator-formality",
    });
    expect(list.body.builtIns).toEqual(defaultAnswerDirectives.map((directive) => ({
      name: directive.name,
      condition: directive.condition,
      action: directive.action,
      priority: directive.priority ?? null,
      description: directive.description ?? null,
    })));

    const update = await request(app)
      .patch(`/api/v1/agents/${agent.body.id}/directives/${create.body.directive.id}`)
      .set("Authorization", authorization)
      .send({
        action: "Use a warm formal register.",
      })
      .expect(200);

    expect(update.body).toMatchObject({
      directive: {
        id: create.body.directive.id,
        action: "Use a warm formal register.",
      },
      coherence: {
        coherent: true,
        conflicts: [],
      },
    });

    await request(app)
      .delete(`/api/v1/agents/${agent.body.id}/directives/${create.body.directive.id}`)
      .set("Authorization", authorization)
      .expect(204);

    await request(app)
      .delete(`/api/v1/agents/${agent.body.id}/directives/${create.body.directive.id}`)
      .set("Authorization", authorization)
      .expect(404);
  });

  it("denies authored directive access across workspaces", async () => {
    const { app } = createTestApp();
    const first = await issueTestToken(app, "agents-directives-first@example.com");
    const second = await issueTestToken(app, "agents-directives-second@example.com");
    const firstAuthorization = `Bearer ${first.token}`;
    const secondAuthorization = `Bearer ${second.token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", firstAuthorization)
      .send({ name: "First workspace directive agent" })
      .expect(201);

    await request(app)
      .get(`/api/v1/agents/${agent.body.id}/directives`)
      .set("Authorization", secondAuthorization)
      .expect(404);

    await request(app)
      .post(`/api/v1/agents/${agent.body.id}/directives`)
      .set("Authorization", secondAuthorization)
      .send({
        name: "cross-workspace",
        condition: { kind: "always" },
        action: "Should not save.",
      })
      .expect(404);
  });

  it("rejects malformed authored directive requests and keeps routes out of the v1 body", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-directives-malformed@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Malformed directive agent" })
      .expect(201);

    await request(app)
      .post(`/api/v1/agents/${agent.body.id}/directives`)
      .set("Authorization", authorization)
      .send({
        name: "missing-action",
        condition: { kind: "always" },
      })
      .expect(400);

    await request(app)
      .post(`/api/v1/agents/${agent.body.id}/directives`)
      .set("Authorization", authorization)
      .send({
        name: "routes-not-public",
        condition: { kind: "always" },
        action: "This includes a field v1 does not expose.",
        routes: ["retrieval_answer"],
      })
      .expect(400);
  });

  it("rejects unauthenticated routine authoring access", async () => {
    const { app } = createTestApp();

    await request(app)
      .get("/api/v1/agents/11111111-1111-4111-8111-111111111111/routines")
      .expect(401);
  });

  it("creates, lists, gets, updates, validates, and publishes routine definitions", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-routines-crud@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Routine authoring" })
      .expect(201);

    const create = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/routines`)
      .set("Authorization", authorization)
      .send(validRoutineDraft())
      .expect(201);

    expect(create.body).toMatchObject({
      routine: {
        id: expect.any(String),
        agentId: agent.body.id,
        name: "support-intake",
        version: 1,
        status: "draft",
      },
      validation: {
        ok: true,
        diagnostics: [],
      },
    });

    const list = await request(app)
      .get(`/api/v1/agents/${agent.body.id}/routines`)
      .set("Authorization", authorization)
      .expect(200);

    expect(list.body.routines).toHaveLength(1);
    expect(list.body.routines[0]).toMatchObject({
      id: create.body.routine.id,
      name: "support-intake",
      status: "draft",
    });

    const get = await request(app)
      .get(`/api/v1/agents/${agent.body.id}/routines/${create.body.routine.id}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(get.body.routine).toMatchObject({
      id: create.body.routine.id,
      slots: [{ key: "topic" }],
    });

    const updateDraft = validRoutineDraft({ name: "support-intake-updated" });
    const update = await request(app)
      .patch(`/api/v1/agents/${agent.body.id}/routines/${create.body.routine.id}`)
      .set("Authorization", authorization)
      .send(updateDraft)
      .expect(200);

    expect(update.body).toMatchObject({
      routine: {
        id: create.body.routine.id,
        name: "support-intake-updated",
        status: "draft",
      },
      validation: {
        ok: true,
      },
    });

    const validate = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/routines/${create.body.routine.id}/validate`)
      .set("Authorization", authorization)
      .expect(200);

    expect(validate.body.validation).toEqual({ ok: true, diagnostics: [] });

    const publish = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/routines/${create.body.routine.id}/publish`)
      .set("Authorization", authorization)
      .expect(200);

    expect(publish.body).toMatchObject({
      routine: {
        id: expect.any(String),
        agentId: agent.body.id,
        name: "support-intake-updated",
        version: 2,
        status: "published",
      },
      validation: {
        ok: true,
        diagnostics: [],
      },
    });
    expect(publish.body.routine.id).not.toEqual(create.body.routine.id);
  });

  it("surfaces routine validation diagnostics and rejects invalid publishes", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-routines-validation@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Routine validation" })
      .expect(201);

    const create = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/routines`)
      .set("Authorization", authorization)
      .send(invalidRoutineDraft())
      .expect(201);

    expect(create.body.validation).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "referenced_undeclared_slot", location: "slot:topic" }),
        expect.objectContaining({ code: "declared_unused_slot", location: "slot:unused" }),
        expect.objectContaining({ code: "dangling_step_reference" }),
      ]),
    });

    const validate = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/routines/${create.body.routine.id}/validate`)
      .set("Authorization", authorization)
      .expect(200);

    expect(validate.body.validation.ok).toBe(false);
    expect(validate.body.validation.diagnostics.length).toBeGreaterThan(0);

    const publish = await request(app)
      .post(`/api/v1/agents/${agent.body.id}/routines/${create.body.routine.id}/publish`)
      .set("Authorization", authorization)
      .expect(422);

    expect(publish.body).toMatchObject({
      error: "Routine definition is invalid",
      validation: {
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "referenced_undeclared_slot" }),
        ]),
      },
    });
  });

  it("rejects website embed copy packs above the locale cap", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-copy-locale-cap@example.com");
    const authorization = `Bearer ${token}`;
    const copy = Object.fromEntries(
      ["en-US", "fr-FR", "de-DE", "es-ES", "it-IT", "pt-BR", "nl-NL", "sv-SE", "da-DK", "fi-FI", "pl-PL"]
        .map((locale) => [locale, { startPrompt: "Hello" }]),
    );

    const response = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Locale-heavy agent",
        surfaceSettings: {
          websiteEmbed: {
            copy,
          },
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("websiteEmbedCopy must not exceed 10 locales");
  });

  it("streams explicit agent identity and keeps the selected agent in the SSE done event", async () => {
    let observedPrompt = "";
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            responseIntent: RESPONSE_INTENT.ASSISTANT_IDENTITY,
            turnKind: REWRITE_TURN_KIND.FRESH_SUBJECT,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.99,
          };
        },
      },
      chatGateway: {
        // Each answer capability owns its own streaming now (#508): a non-retrieval
        // identity turn streams through its skill's streamRender, so the streaming
        // gateway is the path that runs — not the one-shot answer().
        async answer() {
          throw new Error("assistant identity streaming should use the streaming answer path");
        },
        async *streamAnswer(input) {
          observedPrompt = input.prompt;
          yield "I am Balaram.";
        },
      },
    });
    const { token } = await issueTestToken(app, "agents-streaming-identity@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Balaram",
        customInstruction: "You are Balaram, the course guide.",
      })
      .expect(201);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => callback(null, body));
      })
      .send({ agentId: agent.body.id, message: "who are you?", stream: true, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('data: {"text":"I am Balaram."}');
    expect(observedPrompt).toContain("Response identity name: Balaram");
    expect(observedPrompt).toContain("You are Balaram, the course guide.");

    const [done] = parseSseData(response.body, "done");
    expect(done).toMatchObject({
      agentId: agent.body.id,
      agentName: "Balaram",
      answer: "I am Balaram.",
      debug: {
        route: {
          type: "direct",
          reason: "assistant_identity",
        },
      },
    });
  });

  it("keeps legacy settings scoped to the default agent", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agents-legacy-default@example.com");
    const authorization = `Bearer ${session.token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Side agent",
      })
      .expect(201);

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "Default support",
        anonymousChatEnabled: true,
      })
      .expect(200);

    const defaultAgent = await request(app)
      .get(`/api/v1/agents/${defaultAgentId}`)
      .set("Authorization", authorization)
      .expect(200);
    const unchangedSideAgent = await request(app)
      .get(`/api/v1/agents/${sideAgent.body.id}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(defaultAgent.body).toMatchObject({
      name: "Default support",
      surfaceSettings: {
        anonymousChat: {
          enabled: true,
        },
      },
    });
    expect(unchangedSideAgent.body).toMatchObject({
      name: "Side agent",
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
          token: null,
        },
      },
    });
  });

  it("keeps per-agent public surface tokens isolated", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-surface-tokens@example.com");
    const authorization = `Bearer ${token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    await request(app)
      .put(`/api/v1/agents/${defaultAgentId}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://default.example.com"],
          },
        },
      })
      .expect(200);
    const defaultAnonymousToken = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/anonymous-chat-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const defaultEmbedToken = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/website-embed-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);

    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Embed side agent" })
      .expect(201);
    const updatedSideAgent = await request(app)
      .put(`/api/v1/agents/${sideAgent.body.id}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://side.example.com"],
          },
        },
      })
      .expect(200);
    const sideAnonymousToken = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/anonymous-chat-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const sideEmbedToken = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/website-embed-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);

    expect(sideAnonymousToken.body.surfaceSettings.anonymousChat.token).not.toBe(defaultAnonymousToken.body.surfaceSettings.anonymousChat.token);
    expect(sideEmbedToken.body.surfaceSettings.websiteEmbed.token).not.toBe(defaultEmbedToken.body.surfaceSettings.websiteEmbed.token);

    const embedToken = sideEmbedToken.body.surfaceSettings.websiteEmbed.token as string;
    const publicSession = await request(app)
      .post(`/api/v1/public/chat/${embedToken}/sessions`)
      .set("Origin", "https://side.example.com")
      .send({ channel: "website_embed" })
      .expect(200);

    expect(publicSession.body).toMatchObject({
      agentId: updatedSideAgent.body.id,
      publicChatToken: embedToken,
    });

    await request(app)
      .post(`/api/v1/public/chat/${publicSession.body.publicChatToken}`)
      .set("Origin", "https://side.example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "hello side agent", stream: false })
      .expect(200);
  });

  it("preserves enabled website embed settings with empty listed origins as allow-none", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-embed-validation@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Embed validation agent" })
      .expect(201);

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          websiteEmbed: {
            enabled: true,
            allowedOrigins: [],
          },
        },
      })
      .expect(200);
  });

  it("preserves an explicitly empty website embed launcher label in public config", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-empty-embed-label@example.com");
    const authorization = `Bearer ${token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const agentId = list.body.agents[0].id as string;

    const updated = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({
        name: "Claudio",
        surfaceSettings: {
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://host.example.com"],
            launcherLabel: "",
          },
        },
      })
      .expect(200);

    expect(updated.body.name).toBe("Claudio");
    expect(updated.body.surfaceSettings.websiteEmbed.launcherLabel).toBe("");

    const tokenResponse = await request(app)
      .post(`/api/v1/agents/${agentId}/website-embed-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const embedToken = tokenResponse.body.surfaceSettings.websiteEmbed.token as string;

    const config = await request(app)
      .get(`/api/v1/public/chat/${embedToken}/embed-config`)
      .set("Origin", "https://host.example.com")
      .expect(200);

    expect(config.body.launcherLabel).toBe("");
    expect(config.body.launcherLabel).not.toBe("Claudio");
  });

  it("serves a cacheable, per-origin website embed config and rejects strangers", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-embed-config-cache@example.com");
    const authorization = `Bearer ${token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const agentId = list.body.agents[0].id as string;

    await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://host.example.com"],
          },
        },
      })
      .expect(200);

    const tokenResponse = await request(app)
      .post(`/api/v1/agents/${agentId}/website-embed-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const embedToken = tokenResponse.body.surfaceSettings.websiteEmbed.token as string;

    // An allow-listed origin gets a cacheable response that declares it varies
    // by Origin, so a CDN keys the cache per origin. The body is independent of
    // Accept-Language (locale packs are resolved client-side).
    const fromAllowed = await request(app)
      .get(`/api/v1/public/chat/${embedToken}/embed-config`)
      .set("Origin", "https://host.example.com")
      .set("Accept-Language", "fr-FR")
      .expect(200);
    expect(fromAllowed.headers["cache-control"]).toContain("public");
    expect(fromAllowed.headers["vary"]).toContain("Origin");

    const fromAllowedEnglish = await request(app)
      .get(`/api/v1/public/chat/${embedToken}/embed-config`)
      .set("Origin", "https://host.example.com")
      .set("Accept-Language", "en-US")
      .expect(200);
    expect(fromAllowedEnglish.body).toEqual(fromAllowed.body);

    // A non-allow-listed origin is rejected, not served — the cache gate holds.
    await request(app)
      .get(`/api/v1/public/chat/${embedToken}/embed-config`)
      .set("Origin", "https://not-allowed.example.com")
      .expect(400);
  });
});
