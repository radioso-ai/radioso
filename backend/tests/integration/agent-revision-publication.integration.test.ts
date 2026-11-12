import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import { createAgentPublicationProposalAdapter } from "../../src/modules/operatorCopilot/agentPublicationProposalAdapter.js";
import { AgentRevisionService } from "../../src/modules/agents/agentRevision.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("agent revision publication concurrency", () => {
  const accountId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID();
  const first = randomUUID(), second = randomUUID();
  let database: Database;
  let repository: AgentRevisionRepository;

  beforeAll(async () => {
    database = new Database(url!); await runAllTestMigrations(database); repository = new AgentRevisionRepository(database.kysely);
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId,"revision test",`revision-${accountId}@example.com`,"hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId,accountId,"revision",`revision-${workspaceId}`]);
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId,workspaceId,"revision"]);
    const snap = JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [agentId,workspaceId,snap]);
    for (const id of [first, second]) await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)", [id,agentId,workspaceId,snap,1,null]);
  });
  afterAll(async () => { await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined); await database.close(); });

  it("serializes competing publishes and replays one idempotency record", async () => {
    const input = (revisionId: string, key: string) => ({ workspaceId, agentId, actorAccountId: null, revisionId, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: key });
    const [a,b] = await Promise.all([repository.publish(input(first,"one")), repository.publish(input(second,"two"))]);
    expect([a,b].filter((result) => result !== "conflict")).toHaveLength(1);
    expect([a,b].filter((result) => result === "conflict")).toHaveLength(1);
    const winner = a === "conflict" ? b : a;
    if (winner === "conflict" || winner === "idempotency_mismatch") throw new Error("missing winner");
    const replay = await repository.publish(input(winner.revisionId,"one"));
    expect(replay).toMatchObject({ publicationId: winner.publicationId, publishedAt: winner.publishedAt, idempotentReplay: true });
    await expect(repository.publish(input(winner.revisionId === first ? second : first,"one"))).resolves.toBe("idempotency_mismatch");
    const rows = await database.query("SELECT id FROM agent_publications WHERE agent_id=$1", [agentId]);
    expect(rows).toHaveLength(1);
    expect((await repository.findRevision(workspaceId, agentId, winner.revisionId))?.publishedVersion).toBe(1);
    const auditEvents = await database.query("SELECT id FROM audit_events WHERE workspace_id=$1 AND event_type=$2", [workspaceId, "agent_revision.publish"]);
    expect(auditEvents).toHaveLength(1);
  });

  it("rejects a candidate from an older draft generation and marks an exact publication clean", async () => {
    const staleCandidateId = randomUUID();
    const cleanAgentId = randomUUID();
    const currentSnapshot = JSON.stringify({ customInstruction: "current", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [cleanAgentId, workspaceId, "clean revision"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,$3,$4::jsonb)", [cleanAgentId, workspaceId, 2, currentSnapshot]);
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)", [staleCandidateId, cleanAgentId, workspaceId, currentSnapshot, 1, null]);

    await expect(repository.publish({ workspaceId, agentId: cleanAgentId, actorAccountId: null, revisionId: staleCandidateId, expectedDraftGeneration: 2, expectedPublishedRevisionId: null, idempotencyKey: "stale" })).resolves.toBe("conflict");

    const currentCandidateId = randomUUID();
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)", [currentCandidateId, cleanAgentId, workspaceId, currentSnapshot, 2, null]);
    await expect(repository.publish({ workspaceId, agentId: cleanAgentId, actorAccountId: null, revisionId: currentCandidateId, expectedDraftGeneration: 2, expectedPublishedRevisionId: null, idempotencyKey: "current" })).resolves.toMatchObject({ idempotentReplay: false });
    await expect(repository.readState(workspaceId, cleanAgentId)).resolves.toMatchObject({ status: "draft_clean", draft: { basePublishedRevisionId: currentCandidateId } });
  });

  it("reads an agent as published, through the runtime reader, only once it has a published release of its own", async () => {
    const runtime = new AgentRevisionRuntimeRepository(database.kysely);
    const freshAgentId = randomUUID();
    const freshSnapshot = JSON.stringify({ customInstruction: "fresh", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [freshAgentId, workspaceId, "never published"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [freshAgentId, workspaceId, freshSnapshot]);

    await expect(runtime.isPublished({ workspaceId, agentId: freshAgentId })).resolves.toBe(false);

    const candidate = await repository.createCandidate(workspaceId, freshAgentId, { id: randomUUID(), expectedDraftGeneration: 1 });
    if (candidate === "conflict") throw new Error("candidate creation conflicted");
    await expect(runtime.isPublished({ workspaceId, agentId: freshAgentId })).resolves.toBe(false);
    await repository.publish({ workspaceId, agentId: freshAgentId, actorAccountId: null, revisionId: candidate.id, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: "fresh" });

    await expect(runtime.isPublished({ workspaceId, agentId: freshAgentId })).resolves.toBe(true);
    await expect(runtime.isPublished({ workspaceId: randomUUID(), agentId: freshAgentId })).resolves.toBe(false);
  });

  it("reuses the same immutable candidate for the exact saved draft generation", async () => {
    const candidateAgentId = randomUUID();
    const candidateSnapshot = JSON.stringify({ customInstruction: "review", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [candidateAgentId, workspaceId, "candidate reuse"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,$3,$4::jsonb)", [candidateAgentId, workspaceId, 1, candidateSnapshot]);
    const firstCandidate = await repository.createCandidate(workspaceId, candidateAgentId, { id: randomUUID(), expectedDraftGeneration: 1 });
    const secondCandidate = await repository.createCandidate(workspaceId, candidateAgentId, { id: randomUUID(), expectedDraftGeneration: 1 });
    expect(firstCandidate).not.toBe("conflict");
    expect(secondCandidate).not.toBe("conflict");
    if (firstCandidate === "conflict" || secondCandidate === "conflict") throw new Error("candidate creation conflicted");
    expect(secondCandidate.id).toBe(firstCandidate.id);
  });

  it("allocates sequential release versions once per successful publication and preserves retries", async () => {
    const numberedAgentId = randomUUID();
    const numberedSnapshot = JSON.stringify({ customInstruction: "numbered", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [numberedAgentId, workspaceId, "numbered revisions"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [numberedAgentId, workspaceId, numberedSnapshot]);
    const firstCandidate = await repository.createCandidate(workspaceId, numberedAgentId, { id: randomUUID(), expectedDraftGeneration: 1 });
    if (firstCandidate === "conflict") throw new Error("first candidate conflicted");
    const firstPublication = await repository.publish({ workspaceId, agentId: numberedAgentId, actorAccountId: null, revisionId: firstCandidate.id, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: "v1" });
    if (typeof firstPublication === "string") throw new Error("first publication failed");
    expect((await repository.findRevision(workspaceId, numberedAgentId, firstCandidate.id))?.publishedVersion).toBe(1);
    await expect(repository.publish({ workspaceId, agentId: numberedAgentId, actorAccountId: null, revisionId: firstCandidate.id, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: "v1" })).resolves.toMatchObject({ idempotentReplay: true });

    const draft = await repository.mutateDraft(workspaceId, numberedAgentId, (snapshot) => ({ ...snapshot, customInstruction: "second" }));
    if (!draft) throw new Error("numbered draft unavailable");
    const secondCandidate = await repository.createCandidate(workspaceId, numberedAgentId, { id: randomUUID(), expectedDraftGeneration: draft.generation });
    if (secondCandidate === "conflict") throw new Error("second candidate conflicted");
    await expect(repository.publish({ workspaceId, agentId: numberedAgentId, actorAccountId: null, revisionId: secondCandidate.id, expectedDraftGeneration: draft.generation, expectedPublishedRevisionId: firstCandidate.id, idempotencyKey: "v2" })).resolves.toMatchObject({ idempotentReplay: false });
    expect((await repository.findRevision(workspaceId, numberedAgentId, secondCandidate.id))?.publishedVersion).toBe(2);
  });

  it("refuses to rename a published tool at candidate creation and at publish, while keeping the name passes (AS-8)", async () => {
    const exposedAgentId = randomUUID();
    const lineageId = randomUUID();
    const routine = (id: string, exposure: { enabled: boolean; toolName: string }) => ({
      id, agentId: exposedAgentId, lineageId, version: 1, name: "Start a return", enabled: true,
      activation: { triggerDescription: "A customer wants to return an order.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
      slots: [],
      steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask for the order number.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
      exposure: { ...exposure, description: "Start a return." },
      createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z",
    });
    const snapshotWith = (routines: unknown[]) => JSON.stringify({ customInstruction: null, directives: [], routines, contextVariableEnablements: [], agentSkills: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [exposedAgentId, workspaceId, "exposed"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [exposedAgentId, workspaceId, snapshotWith([routine(randomUUID(), { enabled: true, toolName: "start_return" })])]);

    const first = await repository.createCandidate(workspaceId, exposedAgentId, { id: randomUUID(), expectedDraftGeneration: 1 });
    if (first === "conflict") throw new Error("first candidate conflicted");
    const published = await repository.publish({ workspaceId, agentId: exposedAgentId, actorAccountId: null, revisionId: first.id, expectedDraftGeneration: 1, expectedPublishedRevisionId: null, idempotencyKey: "expose-v1" });
    if (typeof published === "string") throw new Error(`first publication failed: ${published}`);

    // A rename of the same lineage is refused where the candidate is frozen...
    const renamed = await repository.mutateDraft(workspaceId, exposedAgentId, (snapshot) => ({ ...snapshot, routines: [routine(randomUUID(), { enabled: true, toolName: "begin_return" }) as never] }));
    if (!renamed) throw new Error("draft unavailable");
    await expect(repository.createCandidate(workspaceId, exposedAgentId, { id: randomUUID(), expectedDraftGeneration: renamed.generation })).rejects.toMatchObject({
      statusCode: 422,
      code: "revision_invalid",
      details: { diagnostics: [expect.objectContaining({ code: "exposure_tool_name_changed" })] },
    });
    // ...and again at publish, for a candidate row that reached the table by another path.
    const smuggledCandidateId = randomUUID();
    await database.query(
      "INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
      [smuggledCandidateId, exposedAgentId, workspaceId, snapshotWith([routine(randomUUID(), { enabled: true, toolName: "begin_return" })]), renamed.generation, first.id],
    );
    await expect(repository.publish({ workspaceId, agentId: exposedAgentId, actorAccountId: null, revisionId: smuggledCandidateId, expectedDraftGeneration: renamed.generation, expectedPublishedRevisionId: first.id, idempotencyKey: "expose-rename" })).rejects.toMatchObject({
      code: "revision_invalid",
      details: { diagnostics: [expect.objectContaining({ code: "exposure_tool_name_changed" })] },
    });

    // Switching the exposure off keeps the frozen name and publishes.
    const withdrawn = await repository.mutateDraft(workspaceId, exposedAgentId, (snapshot) => ({ ...snapshot, routines: [routine(randomUUID(), { enabled: false, toolName: "start_return" }) as never] }));
    if (!withdrawn) throw new Error("draft unavailable");
    const second = await repository.createCandidate(workspaceId, exposedAgentId, { id: randomUUID(), expectedDraftGeneration: withdrawn.generation });
    if (second === "conflict") throw new Error("second candidate conflicted");
    await expect(repository.publish({ workspaceId, agentId: exposedAgentId, actorAccountId: null, revisionId: second.id, expectedDraftGeneration: withdrawn.generation, expectedPublishedRevisionId: first.id, idempotencyKey: "expose-v2" })).resolves.toMatchObject({ idempotentReplay: false });
  });

  it("refuses to publish a sensitive field no consent covers, while the release published before consents keeps serving (#1544)", async () => {
    const consentAgentId = randomUUID();
    const lineageId = randomUUID();
    const english = { locale: "en", body: "We ask whether you are pregnant to book a safe session.", agreeLabel: "I agree", declineLabel: "No thanks" };
    const routine = (consents?: unknown[]) => ({
      id: randomUUID(), agentId: consentAgentId, lineageId, version: 1, name: "Book a session", enabled: true,
      activation: { triggerDescription: "A visitor wants to book a session.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
      slots: [{ stableSlotId: "slot_pregnant", key: "pregnant", type: "boolean", required: true, description: null, ordinal: 0, sensitivity: "sensitive" }],
      steps: [{ stableStepId: "ask_pregnant", kind: "chat", instruction: "Ask whether {{slot.pregnant}}.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "ask_pregnant", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the booking.", ordinal: 0 }],
      ...(consents ? { consents } : {}),
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const snapshotWith = (routines: unknown[]) => JSON.stringify({ customInstruction: null, directives: [], routines, contextVariableEnablements: [], agentSkills: [] });
    const legacySnapshot = snapshotWith([routine()]);
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [consentAgentId, workspaceId, "consent"]);
    // A release published before the coverage rule existed reaches the table the way it did then.
    const legacyRevisionId = randomUUID();
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id,published_at,published_version) VALUES ($1,$2,$3,$4::jsonb,1,NULL,now(),1)", [legacyRevisionId, consentAgentId, workspaceId, legacySnapshot]);
    await database.query("UPDATE agents SET published_revision_id=$1 WHERE id=$2", [legacyRevisionId, consentAgentId]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,base_published_revision_id,snapshot) VALUES ($1,$2,1,$3,$4::jsonb)", [consentAgentId, workspaceId, legacyRevisionId, legacySnapshot]);
    const draftWith = async (routines: unknown[]) => {
      const draft = await repository.mutateDraft(workspaceId, consentAgentId, (snapshot) => ({ ...snapshot, routines: routines as never }));
      if (!draft) throw new Error("draft unavailable");
      return draft.generation;
    };
    // The refusal names what to fix in a message the dashboard shows as is.
    const refusal = (code: string, location: string, named: string) => ({ statusCode: 422, code: "revision_invalid", details: { diagnostics: [expect.objectContaining({ code, location, message: expect.stringContaining(named) })] } });

    // Its next publish asks for the consent, naming the field, at the candidate and again at publish.
    const uncovered = await draftWith([routine()]);
    await expect(repository.createCandidate(workspaceId, consentAgentId, { id: randomUUID(), expectedDraftGeneration: uncovered })).rejects.toMatchObject(refusal("sensitive_slot_without_consent", "slot:pregnant", '"pregnant"'));
    const smuggledCandidateId = randomUUID();
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation,source_base_published_revision_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6)", [smuggledCandidateId, consentAgentId, workspaceId, legacySnapshot, uncovered, legacyRevisionId]);
    await expect(repository.publish({ workspaceId, agentId: consentAgentId, actorAccountId: null, revisionId: smuggledCandidateId, expectedDraftGeneration: uncovered, expectedPublishedRevisionId: legacyRevisionId, idempotencyKey: "uncovered" })).rejects.toMatchObject(refusal("sensitive_slot_without_consent", "slot:pregnant", '"pregnant"'));

    // Meanwhile the release already published keeps serving: the runtime compiles it as published.
    const runtime = new AgentRevisionRuntimeRepository(database.kysely);
    const routines = createPublishedRoutineRegistrationSource(new RoutineDefinitionRepository(database.kysely), { revisionReader: runtime });
    await expect(runtime.findCurrentPublished({ workspaceId, agentId: consentAgentId })).resolves.toMatchObject({ id: legacyRevisionId });
    const served = await routines.load({ workspaceId, agentId: consentAgentId, agentRevisionId: legacyRevisionId });
    expect(served.map((registration) => registration.routine.steps.map((step) => step.kind))).toEqual([["chat", "terminal"]]);

    // A consent that covers the field clears the way.
    const covered = await draftWith([routine([{ key: "pregnancy", slotKeys: ["pregnant"], onDecline: "handoff", variants: [english] }])]);
    const candidate = await repository.createCandidate(workspaceId, consentAgentId, { id: randomUUID(), expectedDraftGeneration: covered });
    if (candidate === "conflict") throw new Error("covered candidate conflicted");
    await expect(repository.publish({ workspaceId, agentId: consentAgentId, actorAccountId: null, revisionId: candidate.id, expectedDraftGeneration: covered, expectedPublishedRevisionId: legacyRevisionId, idempotencyKey: "covered" })).resolves.toMatchObject({ idempotentReplay: false });

    // The agent's default language changes after that publish: the next one needs wording in it.
    await database.query("UPDATE agents SET greeting_settings = COALESCE(greeting_settings, '{}'::jsonb) || '{\"assistantDefaultLocale\":\"it\"}'::jsonb WHERE id=$1", [consentAgentId]);
    const italianDefault = await draftWith([routine([{ key: "pregnancy", slotKeys: ["pregnant"], onDecline: "handoff", variants: [english] }])]);
    await expect(repository.createCandidate(workspaceId, consentAgentId, { id: randomUUID(), expectedDraftGeneration: italianDefault })).rejects.toMatchObject(refusal("consent_missing_default_variant", "consent:pregnancy.variants", '"pregnancy"'));
  });

  it("publishes a sensitive field no step asks the visitor for without a consent, and refuses a consent that could never be asked (#1544)", async () => {
    const lookupAgentId = randomUUID();
    const english = { locale: "en", body: "We keep your diagnosis code with this booking.", agreeLabel: "I agree", declineLabel: "No thanks" };
    // A diagnosis code the booking carries through to its ending: sensitive, so notices mask it,
    // and asked of the visitor by no chat step.
    const routine = (consents?: unknown[]) => ({
      id: randomUUID(), agentId: lookupAgentId, lineageId: randomUUID(), version: 1, name: "Book a session", enabled: true,
      activation: { triggerDescription: "A visitor wants to book a session.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
      slots: [
        { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: null, ordinal: 0 },
        { stableSlotId: "slot_diagnosis_code", key: "diagnosis_code", type: "text", required: false, description: null, ordinal: 1, sensitivity: "sensitive" },
      ],
      steps: [{ stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "ask_name", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the booking under {{slot.diagnosis_code}}.", ordinal: 0 }],
      ...(consents ? { consents } : {}),
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const emptySnapshot = JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [], agentSkills: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [lookupAgentId, workspaceId, "lookup"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [lookupAgentId, workspaceId, emptySnapshot]);
    const draftWith = async (routines: unknown[]) => {
      const draft = await repository.mutateDraft(workspaceId, lookupAgentId, (snapshot) => ({ ...snapshot, routines: routines as never }));
      if (!draft) throw new Error("draft unavailable");
      return draft.generation;
    };

    const covered = await draftWith([routine([{ key: "diagnosis", slotKeys: ["diagnosis_code"], onDecline: "handoff", variants: [english] }])]);
    await expect(repository.createCandidate(workspaceId, lookupAgentId, { id: randomUUID(), expectedDraftGeneration: covered })).rejects.toMatchObject({
      statusCode: 422, code: "revision_invalid",
      details: { diagnostics: [expect.objectContaining({ code: "consent_slot_not_collected", location: "consent:diagnosis.slotKeys.diagnosis_code", message: expect.stringContaining('"diagnosis_code"') })] },
    });

    const uncovered = await draftWith([routine()]);
    const candidate = await repository.createCandidate(workspaceId, lookupAgentId, { id: randomUUID(), expectedDraftGeneration: uncovered });
    if (candidate === "conflict") throw new Error("uncovered candidate conflicted");
    await expect(repository.publish({ workspaceId, agentId: lookupAgentId, actorAccountId: null, revisionId: candidate.id, expectedDraftGeneration: uncovered, expectedPublishedRevisionId: null, idempotencyKey: "looked-up" })).resolves.toMatchObject({ idempotentReplay: false });
  });

  it("recovers the original adapter publication receipt after a later revision supersedes it", async () => {
    const recoveryAgentId = randomUUID();
    const snapshot = JSON.stringify({ customInstruction: "first", directives: [], routines: [], contextVariableEnablements: [] });
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [recoveryAgentId, workspaceId, "recovery"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [recoveryAgentId, workspaceId, snapshot]);
    const service = new AgentRevisionService(repository, () => randomUUID());
    const adapter = createAgentPublicationProposalAdapter({ revisions: service });
    const candidate = await service.createCandidate(workspaceId, recoveryAgentId, 1);
    const targetRef = { agentId: recoveryAgentId, candidateRevisionId: candidate.id };
    const payload = { expectedDraftGeneration: 1, expectedPublishedRevisionId: null };
    const versionToken = "1:none";
    const first = await adapter.applyIfVersionMatches(workspaceId, targetRef, payload, versionToken, { surface: "mcp", accountId, executionInvocationId: "original-execution" });
    if (first.outcome !== "applied") throw new Error("expected initial publication");
    const draft = await service.mutateDraft(workspaceId, recoveryAgentId, (current) => ({ ...current, customInstruction: "later" }));
    const later = await service.createCandidate(workspaceId, recoveryAgentId, draft.generation);
    await service.publish(workspaceId, recoveryAgentId, accountId, { revisionId: later.id, expectedDraftGeneration: draft.generation, expectedPublishedRevisionId: targetRef.candidateRevisionId, idempotencyKey: "later-execution" });
    // The port's `appliedRef` is `unknown` by design (every proposal target shapes it
    // differently); this adapter's own concrete shape is `{ publicationId, revisionId, publishedAt }`.
    const firstAppliedRef = first.appliedRef as { publicationId: string };
    await expect(adapter.applyIfVersionMatches(workspaceId, targetRef, payload, versionToken, { surface: "mcp", accountId, executionInvocationId: "original-execution" })).resolves.toMatchObject({ outcome: "applied", appliedRef: { publicationId: firstAppliedRef.publicationId, revisionId: targetRef.candidateRevisionId } });
  });
});
