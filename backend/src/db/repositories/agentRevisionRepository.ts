import { randomUUID } from "node:crypto";

import { assertCandidateSnapshotIsRunnable, equalScopedAuthoringSnapshots, parseAgentRevisionSnapshot, type AgentDraft, type AgentRevision, type AgentRevisionRepositoryPort, type AgentRevisionSnapshot, type AgentRevisionState, type PublicationResult } from "../../modules/agents/public.js";
import { currentTimestamp, toSanitizedJsonb, transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { agentRevisionLockKey } from "./agentDraftMutation.js";

const mapRevision = (row: {
  id: string;
  snapshot: unknown;
  source_draft_generation: number;
  source_base_published_revision_id: string | null;
  created_at: Date;
  published_at: Date | null;
  published_version: number | null;
}): AgentRevision => ({
  id: row.id,
  snapshot: parseAgentRevisionSnapshot(row.snapshot),
  sourceDraftGeneration: row.source_draft_generation,
  sourceBasePublishedRevisionId: row.source_base_published_revision_id,
  createdAt: new Date(row.created_at),
  publishedAt: row.published_at ? new Date(row.published_at) : null,
  publishedVersion: row.published_version,
});

export class AgentRevisionRepository implements AgentRevisionRepositoryPort {
  constructor(private readonly db: Db) {}
  async initializeDraft(workspaceId: string, agentId: string, customInstruction: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
      await trx.insertInto("agent_drafts").values({ agent_id: agentId, workspace_id: workspaceId, snapshot: toSanitizedJsonb({ customInstruction, directives: [], routines: [], contextVariableEnablements: [] }) }).onConflict((oc) => oc.column("agent_id").doNothing()).execute();
    });
  }
  async mutateDraft(workspaceId: string, agentId: string, mutate: (snapshot: AgentRevisionSnapshot) => AgentRevisionSnapshot): Promise<AgentDraft | null> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
      const current = await trx.selectFrom("agent_drafts")
        .select(["generation", "base_published_revision_id", "snapshot"])
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .executeTakeFirst();
      if (!current) return null;
      const nextSnapshot = parseAgentRevisionSnapshot(mutate(parseAgentRevisionSnapshot(current.snapshot)));
      const row = await trx.updateTable("agent_drafts")
        .set({ generation: current.generation + 1, snapshot: toSanitizedJsonb(nextSnapshot), updated_at: currentTimestamp() })
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .returning(["generation", "base_published_revision_id", "snapshot", "updated_at"])
        .executeTakeFirstOrThrow();
      return {
        generation: row.generation,
        basePublishedRevisionId: row.base_published_revision_id,
        snapshot: parseAgentRevisionSnapshot(row.snapshot),
        updatedAt: new Date(row.updated_at),
      };
    });
  }
  async readDraft(workspaceId: string, agentId: string): Promise<AgentDraft | null> {
    const row = await this.db.selectFrom("agent_drafts").select(["generation", "base_published_revision_id", "snapshot", "updated_at"]).where("workspace_id", "=", workspaceId).where("agent_id", "=", agentId).executeTakeFirst();
    return row ? { generation: row.generation, basePublishedRevisionId: row.base_published_revision_id, snapshot: parseAgentRevisionSnapshot(row.snapshot), updatedAt: new Date(row.updated_at) } : null;
  }
  async readState(workspaceId: string, agentId: string): Promise<AgentRevisionState | null> {
    const draft = await this.readDraft(workspaceId, agentId);
    if (!draft) return null;
    const agent = await this.db.selectFrom("agents").select("published_revision_id").where("workspace_id", "=", workspaceId).where("id", "=", agentId).executeTakeFirst();
    if (!agent) return null;
    const published = agent.published_revision_id ? await this.findRevision(workspaceId, agentId, agent.published_revision_id) : null;
    const status = !published ? "unpublished"
      : draft.basePublishedRevisionId !== published.id ? "published_changed_since_draft"
        : equalScopedAuthoringSnapshots(draft.snapshot, published.snapshot) ? "draft_clean" : "draft_dirty";
    return { agentId, status, draft: { generation: draft.generation, basePublishedRevisionId: draft.basePublishedRevisionId, updatedAt: draft.updatedAt }, publishedRevision: published, canPublish: true };
  }
  async findRevision(workspaceId: string, agentId: string, revisionId: string): Promise<AgentRevision | null> {
    const row = await this.db.selectFrom("agent_revisions").select(["id", "snapshot", "source_draft_generation", "source_base_published_revision_id", "created_at", "published_at", "published_version"]).where("workspace_id", "=", workspaceId).where("agent_id", "=", agentId).where("id", "=", revisionId).executeTakeFirst();
    return row ? mapRevision(row) : null;
  }
  async findRevisionByWorkspace(input: { workspaceId: string; revisionId: string }): Promise<{ agentId: string; revision: AgentRevision } | null> {
    const row = await this.db.selectFrom("agent_revisions").select(["id", "agent_id", "snapshot", "source_draft_generation", "source_base_published_revision_id", "created_at", "published_at", "published_version"]).where("workspace_id", "=", input.workspaceId).where("id", "=", input.revisionId).executeTakeFirst();
    return row ? { agentId: row.agent_id, revision: mapRevision(row) } : null;
  }
  async listRevisions(workspaceId: string, agentId: string): Promise<AgentRevision[]> {
    const rows = await this.db.selectFrom("agent_revisions").select(["id", "snapshot", "source_draft_generation", "source_base_published_revision_id", "created_at", "published_at", "published_version"]).where("workspace_id", "=", workspaceId).where("agent_id", "=", agentId).orderBy("created_at", "desc").execute();
    return rows.map(mapRevision);
  }
  async createCandidate(workspaceId: string, agentId: string, candidate: { id: string; expectedDraftGeneration: number }): Promise<AgentRevision | "conflict"> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
      const draft = await trx.selectFrom("agent_drafts").select(["generation", "base_published_revision_id", "snapshot"]).where("workspace_id", "=", workspaceId).where("agent_id", "=", agentId).executeTakeFirst();
      if (!draft || draft.generation !== candidate.expectedDraftGeneration) return "conflict";
      const parsedSnapshot = parseAgentRevisionSnapshot(draft.snapshot);
      assertCandidateSnapshotIsRunnable(parsedSnapshot);
      let existingQuery = trx.selectFrom("agent_revisions")
        .select(["id", "snapshot", "source_draft_generation", "source_base_published_revision_id", "created_at", "published_at", "published_version"])
        .where("workspace_id", "=", workspaceId)
        .where("agent_id", "=", agentId)
        .where("source_draft_generation", "=", draft.generation)
        .where("published_at", "is", null);
      existingQuery = draft.base_published_revision_id === null
        ? existingQuery.where("source_base_published_revision_id", "is", null)
        : existingQuery.where("source_base_published_revision_id", "=", draft.base_published_revision_id);
      const existing = await existingQuery.execute();
      const reused = existing.find((revision) => JSON.stringify(parseAgentRevisionSnapshot(revision.snapshot)) === JSON.stringify(parsedSnapshot));
      if (reused) return mapRevision(reused);
      const row = await trx.insertInto("agent_revisions").values({ id: candidate.id, workspace_id: workspaceId, agent_id: agentId, snapshot: toSanitizedJsonb(parsedSnapshot), source_draft_generation: draft.generation, source_base_published_revision_id: draft.base_published_revision_id }).returning(["id", "snapshot", "source_draft_generation", "source_base_published_revision_id", "created_at", "published_at", "published_version"]).executeTakeFirstOrThrow();
      return mapRevision(row);
    });
  }
  async publish(input: { workspaceId: string; agentId: string; actorAccountId: string | null; revisionId: string; expectedDraftGeneration: number; expectedPublishedRevisionId: string | null; idempotencyKey: string }): Promise<"conflict" | "idempotency_mismatch" | PublicationResult> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(input.workspaceId, input.agentId)).execute(trx);
      const replay = await trx.selectFrom("agent_publications").select(["id", "revision_id", "created_at", "expected_draft_generation", "expected_published_revision_id"]).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (replay) return replay.revision_id === input.revisionId && replay.expected_draft_generation === input.expectedDraftGeneration && replay.expected_published_revision_id === input.expectedPublishedRevisionId ? { publicationId: replay.id, publishedAt: new Date(replay.created_at), revisionId: replay.revision_id, idempotentReplay: true } : "idempotency_mismatch";
      const [agent, draft, revision] = await Promise.all([
        trx.selectFrom("agents").select("published_revision_id").where("id", "=", input.agentId).where("workspace_id", "=", input.workspaceId).executeTakeFirst(),
        trx.selectFrom("agent_drafts").select(["generation", "base_published_revision_id"]).where("agent_id", "=", input.agentId).where("workspace_id", "=", input.workspaceId).executeTakeFirst(),
        trx.selectFrom("agent_revisions").select(["id", "snapshot", "source_draft_generation", "source_base_published_revision_id", "published_at"]).where("id", "=", input.revisionId).where("agent_id", "=", input.agentId).where("workspace_id", "=", input.workspaceId).executeTakeFirst(),
      ]);
      if (!agent || !draft || !revision || revision.published_at !== null || draft.generation !== input.expectedDraftGeneration || agent.published_revision_id !== input.expectedPublishedRevisionId || revision.source_draft_generation !== draft.generation || revision.source_base_published_revision_id !== draft.base_published_revision_id) return "conflict";
      assertCandidateSnapshotIsRunnable(parseAgentRevisionSnapshot(revision.snapshot));
      const publicationId = randomUUID(); const publishedAt = currentTimestamp();
      const latest = await trx.selectFrom("agent_revisions").select("published_version").where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).where("published_version", "is not", null).orderBy("published_version", "desc").executeTakeFirst();
      const publishedVersion = (latest?.published_version ?? 0) + 1;
      await trx.updateTable("agents").set({ published_revision_id: input.revisionId }).where("id", "=", input.agentId).where("workspace_id", "=", input.workspaceId).execute();
      await trx.updateTable("agent_revisions").set({ published_at: publishedAt, published_version: publishedVersion }).where("id", "=", input.revisionId).where("agent_id", "=", input.agentId).execute();
      await trx.updateTable("agent_drafts").set({ base_published_revision_id: input.revisionId, updated_at: publishedAt }).where("agent_id", "=", input.agentId).where("workspace_id", "=", input.workspaceId).execute();
      const publication = await trx.insertInto("agent_publications").values({ id: publicationId, agent_id: input.agentId, workspace_id: input.workspaceId, revision_id: input.revisionId, previous_revision_id: agent.published_revision_id, idempotency_key: input.idempotencyKey, expected_draft_generation: input.expectedDraftGeneration, expected_published_revision_id: input.expectedPublishedRevisionId, actor_account_id: input.actorAccountId, created_at: publishedAt }).returning(["id", "created_at"]).executeTakeFirstOrThrow();
      await trx.insertInto("audit_events").values({ id: randomUUID(), account_id: input.actorAccountId, workspace_id: input.workspaceId, event_type: "agent_revision.publish", event_status: "success", metadata_json: toSanitizedJsonb({ agentId: input.agentId, revisionId: input.revisionId, publicationId }) }).execute();
      return { publicationId: publication.id, publishedAt: new Date(publication.created_at), revisionId: input.revisionId, idempotentReplay: false };
    });
  }
}
