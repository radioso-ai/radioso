import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";
import { AGENT_BUNDLE_SCHEMA_VERSION } from "../../src/modules/agentBundle/public.js";

const setup = async () => {
  const { app, dependencies, repositories } = createTestApp();
  const session = await issueTestSession(app);
  return { app, dependencies, repositories, session };
};

describe("agent bundle routes", () => {
  it("exports an agent and imports it back as a behaviourally equivalent agent", async () => {
    const { app, session } = await setup();

    const created = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({
        name: "Procurement Bot",
        customInstruction: "Answer with precise procurement guidance.",
        greetingInstruction: "Welcome the visitor by role.",
        assistantDefaultLocale: "en-US",
        contactRequestsEnabled: true,
      })
      .expect(201);

    const agentId: string = created.body.id;

    await request(app)
      .post(`/api/v1/agents/${agentId}/directives`)
      .set(adminSessionHeaders(session))
      .send({
        name: "procurement-tone",
        condition: { kind: "always" },
        action: "Use the procurement team's preferred tone.",
      })
      .expect(201);

    const exported = await request(app)
      .get(`/api/v1/agents/${agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(exported.body.bundleVersion).toBe(AGENT_BUNDLE_SCHEMA_VERSION);
    expect(exported.body.agent.name).toBe("Procurement Bot");
    expect(exported.body.agent.customInstruction).toBe("Answer with precise procurement guidance.");
    expect(exported.body.agent.authoredDirectives).toContainEqual(
      expect.objectContaining({ name: "procurement-tone" }),
    );

    const imported = await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send(exported.body)
      .expect(201);

    expect(imported.body.agentId).toBeTruthy();
    expect(imported.body.agentId).not.toBe(agentId);

    const reExported = await request(app)
      .get(`/api/v1/agents/${imported.body.agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(reExported.body.agent.name).toBe("Procurement Bot");
    expect(reExported.body.agent.customInstruction).toBe("Answer with precise procurement guidance.");
    expect(reExported.body.agent.greetingInstruction).toBe("Welcome the visitor by role.");
    expect(reExported.body.agent.contactRequestsEnabled).toBe(true);
    expect(reExported.body.agent.authoredDirectives).toContainEqual(
      expect.objectContaining({
        name: "procurement-tone",
        action: "Use the procurement team's preferred tone.",
      }),
    );

    // The bundle is stable across a round trip: exporting the import produces the
    // same portable document, which is what makes it usable for GitOps diffing.
    expect(reExported.body.agent).toEqual(exported.body.agent);
  });

  it("carries routines, skills and context-variable enablements across the round trip", async () => {
    const { app, dependencies, session } = await setup();

    const created = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({
        name: "Full Bot",
        internalName: "Procurement (EU)",
        customInstruction: "Answer procurement questions.",
      })
      .expect(201);
    const agentId: string = created.body.id;
    const { workspaceId } = session;

    // Set through the service: `handoffOnRetrievalMiss` is read at turn time by
    // handoffOwnership but no HTTP route writes it yet. The bundle carries it so
    // that when a writer arrives the setting is not quietly left behind.
    await dependencies.agentService.update(workspaceId, agentId, { handoffOnRetrievalMiss: true });

    // A skill whose capability needs no bound connection: it travels whole, so a
    // routine that names it still validates after the move.
    await dependencies.agentSkillsService.create(workspaceId, agentId, {
      name: "knowledge_lookup",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: { vectorTopK: 9 },
      invocationMode: "routine_named",
      enabled: true,
    });

    const variable = await dependencies.contextVariableService.create({
      workspaceId,
      name: "plan_tier",
      description: null,
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    });
    await dependencies.contextVariableService.upsertEnablement({
      workspaceId,
      agentId,
      variableId: variable.id,
      source: "pushed",
      surfacing: "on_reference",
      enabled: true,
    });

    const draft = await dependencies.routineDefinitionService.createDraft(workspaceId, agentId, {
      name: "answer-with-context",
      activation: {
        triggerDescription: "When the visitor asks about their plan",
        gateRef: null,
        priority: 10,
        reentryMode: "once_per_conversation",
      },
      slots: [{
        stableSlotId: "slot_topic",
        key: "topic",
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
        toRef: "terminal_complete",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: "terminal_complete",
        kind: "complete",
        instruction: "Explain the plan difference for {{slot.topic}}.",
        ordinal: 1,
      }],
    });
    await dependencies.routineDefinitionService.publish(workspaceId, agentId, draft.routine.id);

    const exported = await request(app)
      .get(`/api/v1/agents/${agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(exported.body.routines).toHaveLength(1);
    expect(exported.body.routines[0].name).toBe("answer-with-context");
    expect(exported.body.routines[0].definition).not.toHaveProperty("agentId");
    expect(exported.body.agentSkills).toContainEqual(expect.objectContaining({
      name: "knowledge_lookup",
      capability: "retrieve",
    }));
    // Marked portable by the retrieve capability, so the tuning value travels.
    expect(exported.body.agentSkills[0].config).toEqual(expect.objectContaining({ vectorTopK: 9 }));
    expect(exported.body.contextVariables).toEqual([expect.objectContaining({
      variableName: "plan_tier",
      source: "pushed",
    })]);
    // No workspace-scoped id anywhere in the portable collections.
    expect(JSON.stringify(exported.body.contextVariables)).not.toContain(variable.id);

    const imported = await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send(exported.body)
      .expect(201);
    expect(imported.body.unresolved).toEqual([]);

    const reExported = await request(app)
      .get(`/api/v1/agents/${imported.body.agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    // Settings that steer runtime behaviour survive the move, not just the visible
    // ones: handoffOnRetrievalMiss decides whether a retrieval miss asks for a human.
    expect(reExported.body.agent.handoffOnRetrievalMiss).toBe(true);
    expect(reExported.body.agent.internalName).toBe("Procurement (EU)");
    expect(reExported.body.routines).toEqual(exported.body.routines);
    expect(reExported.body.contextVariables).toEqual(exported.body.contextVariables);
    expect(reExported.body.agentSkills).toEqual(exported.body.agentSkills);
  });

  it("round-trips a skill-bound directive and reports the config that stayed home", async () => {
    const { app, dependencies, session } = await setup();

    const created = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({ name: "Bound Bot" })
      .expect(201);
    const agentId: string = created.body.id;
    const { workspaceId } = session;

    // Turn-selectable retrieve skill: the only kinds a directive may bind to.
    await dependencies.agentSkillsService.create(workspaceId, agentId, {
      name: "knowledge_lookup",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      // sourceScope is a retrieve setting the capability does NOT mark portable,
      // because it names document sources that exist in one workspace only.
      config: { vectorTopK: 7, sourceScope: { sourceIds: ["3f7c1a2e-9b4d-4c8a-8f21-5d6e7a8b9c01"] } },
      invocationMode: "agent_selectable",
      enabled: true,
    });

    await request(app)
      .post(`/api/v1/agents/${agentId}/directives`)
      .set(adminSessionHeaders(session))
      .send({
        name: "lookup-first",
        condition: { kind: "always" },
        action: "Look the answer up before replying.",
        binding: { kind: "skill", skillName: "knowledge_lookup" },
      })
      .expect(201);

    const exported = await request(app)
      .get(`/api/v1/agents/${agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(exported.body.agent.authoredDirectives).toContainEqual(expect.objectContaining({
      name: "lookup-first",
      binding: { kind: "skill", skillName: "knowledge_lookup" },
    }));
    // The tuning value travels; the workspace-bound one is named, not carried.
    expect(exported.body.agentSkills[0].config).toEqual(expect.objectContaining({ vectorTopK: 7 }));
    expect(exported.body.agentSkills[0].config).not.toHaveProperty("sourceScope");
    expect(exported.body.agentSkills[0].omittedConfigKeys).toContain("sourceScope");

    const imported = await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send(exported.body)
      .expect(201);

    // The directive's binding resolved, so it imports live rather than switched off.
    expect(imported.body.unresolved).not.toContainEqual(expect.objectContaining({
      kind: "directive_binding_unbound",
    }));
    // And the report survived the transport layer, which is where it used to be lost.
    expect(imported.body.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_config_not_portable",
      element: "skill:knowledge_lookup",
    }));

    const reExported = await request(app)
      .get(`/api/v1/agents/${imported.body.agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(reExported.body.agent.authoredDirectives).toContainEqual(expect.objectContaining({
      name: "lookup-first",
      binding: { kind: "skill", skillName: "knowledge_lookup" },
    }));
  });

  it("rejects a bundle version it does not read, creating nothing", async () => {
    const { app, repositories, session } = await setup();

    const before = await request(app).get("/api/v1/agents").set(adminSessionHeaders(session)).expect(200);

    await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send({
        bundleVersion: 99,
        agent: { schemaVersion: 3, name: "Nope" },
        routines: [],
        contextVariables: [],
        agentSkills: [],
      })
      .expect(400);

    const after = await request(app).get("/api/v1/agents").set(adminSessionHeaders(session)).expect(200);
    expect(after.body.agents).toHaveLength(before.body.agents.length);

    // A refused import is the attempt an operator calls support about, so it leaves
    // a trail rather than being invisible next to the successes.
    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "agent.bundle.imported",
      eventStatus: "failure",
    }));
  });

  it("records an audit event for both directions, with counts and no bundle contents", async () => {
    const { app, repositories, session } = await setup();

    const created = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({ name: "Audited Bot", customInstruction: "A secret instruction nobody should log." })
      .expect(201);

    const exported = await request(app)
      .get(`/api/v1/agents/${created.body.id}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send(exported.body)
      .expect(201);

    const events = repositories.auditEventRepository.items;
    expect(events).toContainEqual(expect.objectContaining({
      eventType: "agent.bundle.exported",
      eventStatus: "success",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      eventType: "agent.bundle.imported",
      eventStatus: "success",
    }));

    const bundleEvents = events.filter((event) => event.eventType.startsWith("agent.bundle."));
    expect(JSON.stringify(bundleEvents)).not.toContain("A secret instruction nobody should log.");
    for (const event of bundleEvents) {
      expect(event.metadata).toEqual(expect.objectContaining({ bundleVersion: AGENT_BUNDLE_SCHEMA_VERSION }));
    }
  });

  it("returns 404 for an agent in another workspace", async () => {
    const { app, session } = await setup();
    const other = await issueTestSession(app, `other-${Date.now()}@example.com`);

    const created = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(other))
      .send({ name: "Someone else's bot" })
      .expect(201);

    await request(app)
      .get(`/api/v1/agents/${created.body.id}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(404);
  });

  it("round-trips an agent whose only skill has no portable settings", async () => {
    // `notify` declares recipient emails and a webhook URL and nothing else, and
    // neither travels. Export therefore hands import a config with every declared
    // value gone, and import creates the skill from exactly that object — so the
    // capability has to accept its own stripped config. When it did not, an agent
    // carrying a notify skill could not be imported at all: the create rejection
    // aborted the whole bundle and the compensating delete removed the new agent.
    const { app, dependencies, session } = await setup();
    const { workspaceId } = session;

    const created = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({ name: "Escalation Bot", customInstruction: "Escalate when asked." })
      .expect(201);
    const agentId: string = created.body.id;

    await dependencies.agentSkillsService.create(workspaceId, agentId, {
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: {
        delivery: {
          recipientEmails: ["ops@example.com"],
          webhook: { url: "https://hooks.example.com/inbound" },
        },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    const exported = await request(app)
      .get(`/api/v1/agents/${agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);

    const [exportedSkill] = exported.body.agentSkills;
    expect(exportedSkill.name).toBe("notify_ops");
    // The values stayed home; only their key names travelled.
    expect(JSON.stringify(exportedSkill.config)).not.toContain("ops@example.com");
    expect(JSON.stringify(exportedSkill.config)).not.toContain("hooks.example.com");
    expect(exportedSkill.omittedConfigKeys).toEqual(expect.arrayContaining([
      "delivery.recipientEmails",
      "delivery.webhook.url",
    ]));

    const imported = await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send(exported.body)
      .expect(201);

    // The skill exists on the new agent — reported, not refused, and not skipped.
    const reExported = await request(app)
      .get(`/api/v1/agents/${imported.body.agentId}/bundle`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(reExported.body.agentSkills).toContainEqual(
      expect.objectContaining({ name: "notify_ops", capability: "notify" }),
    );
    expect(imported.body.unresolved).toContainEqual(expect.objectContaining({
      kind: "skill_config_not_portable",
      element: "skill:notify_ops",
    }));
  });

  it("answers a malformed bundle with 400 rather than an unhandled server error", async () => {
    // The body schema checks that this is a bundle, not what a bundle contains, so
    // a body this shallow reaches the import service. Reading through its absent
    // sections used to be a TypeError, which the error handler could only render
    // as a 500 for what is plainly a bad request.
    const { app, session } = await setup();

    const response = await request(app)
      .post("/api/v1/agents/bundle")
      .set(adminSessionHeaders(session))
      .send({ bundleVersion: AGENT_BUNDLE_SCHEMA_VERSION, agent: { schemaVersion: 3 } });

    expect(response.status).toBe(400);
  });
});
