import { randomUUID } from "node:crypto";

import {
  assertCandidateSnapshotIsRunnable,
  equalScopedAuthoringSnapshots,
  parseAgentRevisionSnapshot,
  type AgentDraft,
  type AgentRevision,
  type AgentRevisionRepositoryPort,
  type AgentRevisionSnapshot,
  type AgentRevisionState,
  type PublicationResult,
} from "../../src/modules/agents/public.js";

interface DraftRow {
  generation: number;
  basePublishedRevisionId: string | null;
  snapshot: AgentRevisionSnapshot;
  updatedAt: Date;
}

interface RevisionRow {
  id: string;
  workspaceId: string;
  agentId: string;
  snapshot: AgentRevisionSnapshot;
  sourceDraftGeneration: number;
  sourceBasePublishedRevisionId: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  publishedVersion: number | null;
}

interface PublicationRow {
  id: string;
  revisionId: string;
  expectedDraftGeneration: number;
  expectedPublishedRevisionId: string | null;
  createdAt: Date;
}

const draftKey = (workspaceId: string, agentId: string): string => `${workspaceId}:${agentId}`;

/** A round trip through JSON + the snapshot schema, mirroring what a real jsonb column
 * write/read does: it detaches the returned object from this repository's own state (so a
 * caller mutating a returned snapshot cannot corrupt it) and re-validates/coerces it (e.g.
 * ISO date strings back into `Date`s) the same way a Postgres read does. */
const cloneSnapshot = (snapshot: AgentRevisionSnapshot): AgentRevisionSnapshot =>
  parseAgentRevisionSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown);

const toAgentRevision = (row: RevisionRow): AgentRevision => ({
  id: row.id,
  snapshot: cloneSnapshot(row.snapshot),
  sourceDraftGeneration: row.sourceDraftGeneration,
  sourceBasePublishedRevisionId: row.sourceBasePublishedRevisionId,
  createdAt: row.createdAt,
  publishedAt: row.publishedAt,
  publishedVersion: row.publishedVersion,
});

/**
 * Mirrors `AgentRevisionRepository` (src/db/repositories/agentRevisionRepository.ts) closely
 * enough that the HTTP release-gate routes (`agentRevisionRoutes.ts`) are genuinely exercised
 * in tests: same draft-generation/candidate-reuse/idempotent-publish semantics, and the same
 * `assertCandidateSnapshotIsRunnable` structural gate the real repository runs inside
 * `createCandidate`/`publish`. `AgentRevisionService`'s own servability gate
 * (`assertCandidateSnapshotIsServable`, driven by the `RoutineServingValidator` passed to the
 * service) is exercised for free by any caller that wires a real `RoutineDefinitionService` in
 * front of this repository — this class has no opinion on that check.
 *
 * What this does not model: SQL transactions, concurrent-write races, or the
 * `agents.published_revision_id` column as a separate table — the latter is tracked as private
 * state here instead, the same way the real repository reaches into a second table from inside
 * one method without another repository object being involved.
 */
export class InMemoryAgentRevisionRepository implements AgentRevisionRepositoryPort {
  private readonly drafts = new Map<string, DraftRow>();
  private readonly publishedRevisionIds = new Map<string, string | null>();
  private readonly revisions = new Map<string, RevisionRow>();
  /** Keyed by `${agentId}:${idempotencyKey}`, matching the real table's unique constraint. */
  private readonly publications = new Map<string, PublicationRow>();

  async initializeDraft(workspaceId: string, agentId: string, customInstruction: string): Promise<void> {
    const key = draftKey(workspaceId, agentId);
    if (this.drafts.has(key)) return; // mirrors ON CONFLICT (agent_id) DO NOTHING
    this.drafts.set(key, {
      generation: 1,
      basePublishedRevisionId: null,
      snapshot: parseAgentRevisionSnapshot({
        customInstruction, directives: [], routines: [], contextVariableEnablements: [], agentSkills: [],
      }),
      updatedAt: new Date(),
    });
    this.publishedRevisionIds.set(key, null);
  }

  async mutateDraft(
    workspaceId: string,
    agentId: string,
    mutate: (snapshot: AgentRevisionSnapshot) => AgentRevisionSnapshot,
  ): Promise<AgentDraft | null> {
    const key = draftKey(workspaceId, agentId);
    const current = this.drafts.get(key);
    if (!current) return null;
    const nextSnapshot = parseAgentRevisionSnapshot(mutate(cloneSnapshot(current.snapshot)));
    const updated: DraftRow = {
      generation: current.generation + 1,
      basePublishedRevisionId: current.basePublishedRevisionId,
      snapshot: nextSnapshot,
      updatedAt: new Date(),
    };
    this.drafts.set(key, updated);
    return { generation: updated.generation, basePublishedRevisionId: updated.basePublishedRevisionId, snapshot: cloneSnapshot(updated.snapshot), updatedAt: updated.updatedAt };
  }

  async readDraft(workspaceId: string, agentId: string): Promise<AgentDraft | null> {
    const row = this.drafts.get(draftKey(workspaceId, agentId));
    return row
      ? { generation: row.generation, basePublishedRevisionId: row.basePublishedRevisionId, snapshot: cloneSnapshot(row.snapshot), updatedAt: row.updatedAt }
      : null;
  }

  async readState(workspaceId: string, agentId: string): Promise<AgentRevisionState | null> {
    const key = draftKey(workspaceId, agentId);
    const draft = this.drafts.get(key);
    if (!draft) return null;
    const publishedRevisionId = this.publishedRevisionIds.get(key) ?? null;
    const published = publishedRevisionId ? await this.findRevision(workspaceId, agentId, publishedRevisionId) : null;
    const status: AgentRevisionState["status"] = !published
      ? "unpublished"
      : draft.basePublishedRevisionId !== published.id
        ? "published_changed_since_draft"
        : equalScopedAuthoringSnapshots(draft.snapshot, published.snapshot) ? "draft_clean" : "draft_dirty";
    return {
      agentId,
      status,
      draft: { generation: draft.generation, basePublishedRevisionId: draft.basePublishedRevisionId, updatedAt: draft.updatedAt },
      publishedRevision: published,
      canPublish: true,
    };
  }

  async findRevision(workspaceId: string, agentId: string, revisionId: string): Promise<AgentRevision | null> {
    const row = this.revisions.get(revisionId);
    return row && row.workspaceId === workspaceId && row.agentId === agentId ? toAgentRevision(row) : null;
  }

  async findRevisionByWorkspace(input: { workspaceId: string; revisionId: string }): Promise<{ agentId: string; revision: AgentRevision } | null> {
    const row = this.revisions.get(input.revisionId);
    return row && row.workspaceId === input.workspaceId ? { agentId: row.agentId, revision: toAgentRevision(row) } : null;
  }

  async listRevisions(workspaceId: string, agentId: string): Promise<AgentRevision[]> {
    return [...this.revisions.values()]
      .filter((row) => row.workspaceId === workspaceId && row.agentId === agentId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id))
      .map(toAgentRevision);
  }

  async createCandidate(
    workspaceId: string,
    agentId: string,
    candidate: { id: string; expectedDraftGeneration: number },
  ): Promise<AgentRevision | "conflict"> {
    const key = draftKey(workspaceId, agentId);
    const draft = this.drafts.get(key);
    if (!draft || draft.generation !== candidate.expectedDraftGeneration) return "conflict";
    const parsedSnapshot = cloneSnapshot(draft.snapshot);
    // Structural gate (directive scope closure, disabled-routine exemption): the same check
    // the real repository runs inside its own transaction before persisting a candidate row.
    assertCandidateSnapshotIsRunnable(parsedSnapshot);
    const existing = [...this.revisions.values()].filter((row) =>
      row.workspaceId === workspaceId &&
      row.agentId === agentId &&
      row.sourceDraftGeneration === draft.generation &&
      row.publishedAt === null &&
      row.sourceBasePublishedRevisionId === draft.basePublishedRevisionId);
    const reused = existing.find((row) => JSON.stringify(row.snapshot) === JSON.stringify(parsedSnapshot));
    if (reused) return toAgentRevision(reused);
    const row: RevisionRow = {
      id: candidate.id,
      workspaceId,
      agentId,
      snapshot: parsedSnapshot,
      sourceDraftGeneration: draft.generation,
      sourceBasePublishedRevisionId: draft.basePublishedRevisionId,
      createdAt: new Date(),
      publishedAt: null,
      publishedVersion: null,
    };
    this.revisions.set(row.id, row);
    return toAgentRevision(row);
  }

  async publish(input: {
    workspaceId: string; agentId: string; actorAccountId: string | null; revisionId: string;
    expectedDraftGeneration: number; expectedPublishedRevisionId: string | null; idempotencyKey: string;
  }): Promise<"conflict" | "idempotency_mismatch" | PublicationResult> {
    const publicationKey = `${input.agentId}:${input.idempotencyKey}`;
    const replay = this.publications.get(publicationKey);
    if (replay) {
      return replay.revisionId === input.revisionId &&
        replay.expectedDraftGeneration === input.expectedDraftGeneration &&
        replay.expectedPublishedRevisionId === input.expectedPublishedRevisionId
        ? { publicationId: replay.id, publishedAt: replay.createdAt, revisionId: replay.revisionId, idempotentReplay: true }
        : "idempotency_mismatch";
    }
    const key = draftKey(input.workspaceId, input.agentId);
    const draft = this.drafts.get(key);
    const currentPublishedRevisionId = this.publishedRevisionIds.get(key) ?? null;
    const revision = this.revisions.get(input.revisionId);
    const revisionMatches = revision && revision.workspaceId === input.workspaceId && revision.agentId === input.agentId;
    if (
      !draft ||
      !revisionMatches ||
      revision.publishedAt !== null ||
      draft.generation !== input.expectedDraftGeneration ||
      currentPublishedRevisionId !== input.expectedPublishedRevisionId ||
      revision.sourceDraftGeneration !== draft.generation ||
      revision.sourceBasePublishedRevisionId !== draft.basePublishedRevisionId
    ) {
      return "conflict";
    }
    assertCandidateSnapshotIsRunnable(cloneSnapshot(revision.snapshot));
    const publicationId = randomUUID();
    const publishedAt = new Date();
    const latestPublishedVersion = [...this.revisions.values()]
      .filter((row) => row.workspaceId === input.workspaceId && row.agentId === input.agentId && row.publishedVersion !== null)
      .reduce((max, row) => Math.max(max, row.publishedVersion ?? 0), 0);
    const publishedVersion = latestPublishedVersion + 1;
    this.publishedRevisionIds.set(key, input.revisionId);
    revision.publishedAt = publishedAt;
    revision.publishedVersion = publishedVersion;
    this.drafts.set(key, { ...draft, basePublishedRevisionId: input.revisionId, updatedAt: publishedAt });
    this.publications.set(publicationKey, {
      id: publicationId,
      revisionId: input.revisionId,
      expectedDraftGeneration: input.expectedDraftGeneration,
      expectedPublishedRevisionId: input.expectedPublishedRevisionId,
      createdAt: publishedAt,
    });
    return { publicationId, publishedAt, revisionId: input.revisionId, idempotentReplay: false };
  }
}
