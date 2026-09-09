import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
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
});
