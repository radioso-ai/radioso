import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildContactDeliveryResolver } from "../../src/app/composition/contactDelivery.js";
import { buildConversationScopedSkillLookups, buildConversationSkills } from "../../src/app/composition/conversationSkills.js";
import { presentRevisionDetail } from "../../src/app/http/routes/agentRevisionPresenters.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { EmailSkillDefinitionRepository } from "../../src/db/repositories/emailSkillDefinitionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../src/db/repositories/externalSkillDefinitionRepository.js";
import { WebhookSkillDefinitionRepository } from "../../src/db/repositories/webhookSkillDefinitionRepository.js";
import { NotifyExecutor } from "../../src/modules/notify/notifyExecutor.js";
import { SlackSkillDefinitionRepository } from "../../src/modules/slackSkills/repository.js";
import { WebhookSkillExecutor } from "../../src/modules/webhookSkills/public.js";
import { withConversationSkills } from "../../src/shared/domain/conversationSkills.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { AgentRevisionRuntimeResolver, AgentRevisionService } from "../../src/modules/agents/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Skill writes go into the agent's draft and conversations read skills from the published
// release, so a skills-only edit has to count as a draft change: otherwise Publish stays off,
// Test Chat runs the published release, and the edit ships unreviewed with an unrelated publish.
describeDb("a skills-only edit across an agent's draft and releases", () => {
  const accountId = randomUUID(), workspaceId = randomUUID();
  let database: Database;
  let agents: AgentRepository;
  let skills: AgentSkillRepository;
  let revisions: AgentRevisionRepository;
  let service: AgentRevisionService;
  let resolver: AgentRevisionRuntimeResolver;

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    agents = new AgentRepository(database.kysely);
    skills = new AgentSkillRepository(database.kysely);
    revisions = new AgentRevisionRepository(database.kysely);
    service = new AgentRevisionService(revisions, randomUUID);
    resolver = new AgentRevisionRuntimeResolver(new AgentRevisionRuntimeRepository(database.kysely));
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "skill draft test", `skill-draft-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "skill draft", `skill-draft-${workspaceId}`]);
  });
  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined);
    await database.close();
  });

  const publishDraft = async (agentId: string) => {
    const state = await service.state(workspaceId, agentId);
    const candidate = await service.createCandidate(workspaceId, agentId, state.draft.generation);
    await service.publish(workspaceId, agentId, null, {
      revisionId: candidate.id,
      expectedDraftGeneration: state.draft.generation,
      expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
      idempotencyKey: randomUUID(),
    });
    return candidate;
  };

  const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

  /** The executors as production wires them: each reads the skill row from the conversation's set. */
  const lookups = () => buildConversationScopedSkillLookups(buildConversationSkills(database.kysely), {
    externalSkills: new ExternalSkillDefinitionRepository(database.kysely),
    webhookSkills: new WebhookSkillDefinitionRepository(database.kysely),
    emailSkills: new EmailSkillDefinitionRepository(database.kysely),
    slackSkills: new SlackSkillDefinitionRepository(database.kysely),
    agentSkills: skills,
  });

  /** The skills a new visitor conversation runs: the agent's current release, as a turn resolves it. */
  const visitorConversationSkills = async (agentId: string) => {
    const agent = await agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) throw new Error("agent missing");
    const resolved = await resolver.resolveNew({ workspaceId, agent });
    return buildConversationSkills(database.kysely).forTurn(resolved.agent);
  };

  /** Runs a notify skill the way a visitor conversation's routine step would. */
  const notifyForVisitor = async (agentId: string, skillName: string) => {
    const executor = new NotifyExecutor({ skills: lookups().notify, outbox: { enqueue: async () => ({ id: randomUUID(), duplicate: false }) } });
    const conversationId = randomUUID();
    const result = await executor.dispatch({
      skill: { name: skillName },
      collected: { message: "Please call me back" },
      context: { workspaceId, agentId, conversationId, sessionId: conversationId, ...withConversationSkills(await visitorConversationSkills(agentId)) },
      emit: noopEmit,
    });
    return result.disposition === "settled" ? result.outcome.status : "deferred";
  };

  const createLookupSkill = (agentId: string) => skills.create({
    workspaceId,
    agentId,
    skillName: "lookup_orders",
    kind: "notify",
    config: { delivery: { recipientEmails: ["orders@acme.example"] } },
    invocationMode: "agent_selectable",
    enabled: true,
  });

  it("marks the draft changed, lists the skill by name in the review, tests it, and reaches visitors only after publish", async () => {
    const agent = await agents.create(workspaceId, { name: "Skills draft", customInstruction: "Be brief." });
    await publishDraft(agent.id);
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });

    await createLookupSkill(agent.id);

    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });
    expect(await notifyForVisitor(agent.id, "lookup_orders")).toBe("failed");

    const tested = await service.resolveDefaultTestRevision(workspaceId, agent.id);
    const candidate = await service.detail(workspaceId, agent.id, tested.revisionId);
    expect(candidate.snapshot.agentSkills?.map((skill) => skill.skillName)).toContain("lookup_orders");
    const base = await service.detail(workspaceId, agent.id, candidate.sourceBasePublishedRevisionId!);
    expect(presentRevisionDetail(candidate, base).scopedChanges.agentSkills).toEqual([
      expect.objectContaining({ skillName: "lookup_orders", change: "added" }),
    ]);

    await publishDraft(agent.id);

    expect(await notifyForVisitor(agent.id, "lookup_orders")).toBe("delivered");
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });
  });

  it("keeps running a released skill a visitor conversation is pinned to after it is switched off live, until publish", async () => {
    const agent = await agents.create(workspaceId, { name: "Skills switched off", customInstruction: "Be brief." });
    const skill = await createLookupSkill(agent.id);
    await publishDraft(agent.id);

    await skills.update(workspaceId, agent.id, skill.id, { enabled: false });

    expect(await notifyForVisitor(agent.id, "lookup_orders")).toBe("delivered");
    await publishDraft(agent.id);
    expect(await notifyForVisitor(agent.id, "lookup_orders")).toBe("failed");
  });

  it("drafts a skill written through a per-kind skill route, and runs the release's binding until publish", async () => {
    const agent = await agents.create(workspaceId, { name: "Webhook skills", customInstruction: "Be brief." });
    await publishDraft(agent.id);
    const destinationId = randomUUID();
    await database.query(
      "INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [destinationId, workspaceId, "Tickets", "https://hooks.acme.example/tickets", "enc", "key-1"],
    );
    const webhookSkills = new WebhookSkillDefinitionRepository(database.kysely);
    const created = await webhookSkills.create({ workspaceId, agentId: agent.id, destinationId, skillName: "post_ticket", boundPayload: { queue: "support" }, exposedPayload: {}, enabled: true });

    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });
    await publishDraft(agent.id);
    await webhookSkills.update(workspaceId, agent.id, created.id, { boundPayload: { queue: "sales" } });
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });

    const posted: Array<{ body?: unknown }> = [];
    const executor = new WebhookSkillExecutor({
      skills: lookups().webhook,
      destinations: { resolve: async () => ({ url: "https://hooks.acme.example/tickets", secret: "secret" }) },
      httpClient: { post: async (request) => void posted.push(request as { body?: unknown }) },
    });
    const result = await executor.dispatch({
      skill: { name: "post_ticket" },
      collected: {},
      context: { workspaceId, agentId: agent.id, sessionId: randomUUID(), ...withConversationSkills(await visitorConversationSkills(agent.id)) },
      emit: noopEmit,
    });

    expect(result).toMatchObject({ disposition: "settled" });
    expect(JSON.stringify(posted)).toContain("support");
    expect(JSON.stringify(posted)).not.toContain("sales");
  });

  it("delivers a queued contact request to its conversation's release recipients, not ones edited live", async () => {
    const agent = await agents.create(workspaceId, { name: "Contact team", customInstruction: "Be brief." });
    const contactTeam = await skills.create({
      workspaceId,
      agentId: agent.id,
      skillName: "contact_team",
      kind: "notify",
      config: { delivery: { recipientEmails: ["support@acme.example"], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
    const release = await publishDraft(agent.id);
    await skills.update(workspaceId, agent.id, contactTeam.id, { replaceConfig: { delivery: { recipientEmails: ["sales@acme.example"], webhook: null } } });
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel, agent_revision_id) VALUES ($1,$2,$3,'web',$4)",
      [conversationId, workspaceId, agent.id, release.id],
    );

    const target = await buildContactDeliveryResolver(database).resolve({ workspaceId, conversationId, skillName: "contact_team" } as never);

    expect(target.emails).toEqual(["support@acme.example"]);
  });

  it("keeps the draft clean when a skill save leaves it as published, though the row was rewritten", async () => {
    const agent = await agents.create(workspaceId, { name: "Skills unchanged", customInstruction: "Be brief." });
    const skill = await createLookupSkill(agent.id);
    await publishDraft(agent.id);

    await skills.update(workspaceId, agent.id, skill.id, { enabled: false });
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_dirty" });
    await skills.update(workspaceId, agent.id, skill.id, { enabled: true });

    const draft = await revisions.readDraft(workspaceId, agent.id);
    expect(draft?.snapshot.agentSkills?.find((entry) => entry.id === skill.id)?.updatedAt.getTime()).toBeGreaterThan(skill.updatedAt.getTime());
    await expect(revisions.readState(workspaceId, agent.id)).resolves.toMatchObject({ status: "draft_clean" });
  });
});
