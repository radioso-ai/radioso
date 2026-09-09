import { describe, expect, it } from "vitest";

import {
  AgentRevisionService,
  type AgentRevisionRepositoryPort,
  type AgentRevisionSnapshot,
} from "../../src/modules/agents/agentRevision.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const snapshot = (instruction: string): AgentRevisionSnapshot => ({
  customInstruction: instruction,
  directives: [],
  routines: [],
  contextVariableEnablements: [],
});

class InMemoryRevisionRepository implements AgentRevisionRepositoryPort {
  draft = { generation: 2, basePublishedRevisionId: "published-1", snapshot: snapshot("draft v1"), updatedAt: new Date("2026-09-08T00:00:00.000Z") };
  publishedRevisionId = "published-1";
  readonly revisions = new Map<string, AgentRevisionSnapshot>([["published-1", snapshot("published v1")]]);
  readonly publications: Array<{ revisionId: string; idempotencyKey: string }> = [];

  async initializeDraft() {}
  async mutateDraft(_workspaceId: string, _agentId: string, mutate: (value: AgentRevisionSnapshot) => AgentRevisionSnapshot) {
    this.draft = { ...this.draft, generation: this.draft.generation + 1, snapshot: mutate(this.draft.snapshot) };
    return this.draft;
  }
  async readDraft() { return this.draft; }
  async readState(_workspaceId: string, agentId: string) {
    return { agentId, status: "draft_dirty" as const, draft: { generation: this.draft.generation, basePublishedRevisionId: this.draft.basePublishedRevisionId, updatedAt: this.draft.updatedAt }, publishedRevision: null, canPublish: true };
  }
  async findRevision(_workspaceId: string, _agentId: string, revisionId: string) {
    const value = this.revisions.get(revisionId);
    return value ? { id: revisionId, snapshot: value, sourceDraftGeneration: this.draft.generation, sourceBasePublishedRevisionId: this.draft.basePublishedRevisionId, createdAt: new Date("2026-09-08T00:00:00.000Z"), publishedAt: null, publishedVersion: null } : null;
  }
  async findRevisionByWorkspace(input: { workspaceId: string; revisionId: string }) {
    const revision = await this.findRevision(input.workspaceId, agentId, input.revisionId);
    return revision ? { agentId, revision } : null;
  }
  async listRevisions() { return []; }
  async createCandidate(_workspaceId: string, _agentId: string, candidate: { id: string; expectedDraftGeneration: number }) {
    if (candidate.expectedDraftGeneration !== this.draft.generation) return "conflict" as const;
    this.revisions.set(candidate.id, this.draft.snapshot);
    return { id: candidate.id, snapshot: this.draft.snapshot, sourceDraftGeneration: this.draft.generation, sourceBasePublishedRevisionId: this.draft.basePublishedRevisionId, createdAt: new Date("2026-09-08T00:00:00.000Z"), publishedAt: null, publishedVersion: null };
  }
  async publish(input: { workspaceId: string; agentId: string; actorAccountId: string | null; revisionId: string; expectedDraftGeneration: number; expectedPublishedRevisionId: string | null; idempotencyKey: string }) {
    const prior = this.publications.find((publication) => publication.idempotencyKey === input.idempotencyKey);
    if (prior) return { publicationId: "publication-1", publishedAt: new Date("2026-09-08T00:00:00.000Z"), revisionId: prior.revisionId, idempotentReplay: true };
    if (input.expectedDraftGeneration !== this.draft.generation || input.expectedPublishedRevisionId !== this.publishedRevisionId) return "conflict" as const;
    this.publications.push({ revisionId: input.revisionId, idempotencyKey: input.idempotencyKey });
    this.publishedRevisionId = input.revisionId;
    return { publicationId: "publication-1", publishedAt: new Date("2026-09-08T00:00:00.000Z"), revisionId: input.revisionId, idempotentReplay: false };
  }
}

describe("AgentRevisionService", () => {
  it("publishes the immutable candidate selected from a saved draft, preserving later draft edits", async () => {
    const repository = new InMemoryRevisionRepository();
    const service = new AgentRevisionService(repository, () => "candidate-1");

    const candidate = await service.createCandidate(workspaceId, agentId, 2);
    repository.draft = { ...repository.draft, generation: 3, snapshot: snapshot("draft v2") };

    const result = await service.publish(workspaceId, agentId, null, {
      revisionId: candidate.id,
      expectedDraftGeneration: 3,
      expectedPublishedRevisionId: "published-1",
      idempotencyKey: "publish-1",
    });

    expect(result).toMatchObject({ revisionId: "candidate-1", idempotentReplay: false });
    expect(repository.revisions.get("candidate-1")).toEqual(snapshot("draft v1"));
    expect(repository.draft.snapshot).toEqual(snapshot("draft v2"));
  });

  it("rejects a stale publish without moving the pointer", async () => {
    const repository = new InMemoryRevisionRepository();
    const service = new AgentRevisionService(repository, () => "candidate-1");
    await service.createCandidate(workspaceId, agentId, 2);

    await expect(service.publish(workspaceId, agentId, null, {
      revisionId: "candidate-1", expectedDraftGeneration: 1, expectedPublishedRevisionId: "published-1", idempotencyKey: "publish-1",
    })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(repository.publishedRevisionId).toBe("published-1");
  });

  it("returns the original result when a publish is retried with the same key", async () => {
    const repository = new InMemoryRevisionRepository();
    const service = new AgentRevisionService(repository, () => "candidate-1");
    await service.createCandidate(workspaceId, agentId, 2);
    const input = { revisionId: "candidate-1", expectedDraftGeneration: 2, expectedPublishedRevisionId: "published-1", idempotencyKey: "publish-1" };

    await service.publish(workspaceId, agentId, null, input);
    await expect(service.publish(workspaceId, agentId, null, input)).resolves.toMatchObject({ revisionId: "candidate-1", idempotentReplay: true });
    expect(repository.publications).toHaveLength(1);
  });

});
