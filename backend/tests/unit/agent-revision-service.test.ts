import { describe, expect, it, vi } from "vitest";

import {
  AgentRevisionService,
  type AgentRevision,
  type AgentRevisionRepositoryPort,
  type AgentRevisionSnapshot,
  type RoutineServingValidator,
} from "../../src/modules/agents/agentRevision.js";
import type { RoutineValidationResult } from "../../src/modules/routines/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const routineLineageId = "88888888-8888-4888-8888-888888888888";
const routineId = "99999999-9999-4999-8999-999999999999";

const snapshot = (instruction: string): AgentRevisionSnapshot => ({
  customInstruction: instruction,
  directives: [],
  routines: [],
  contextVariableEnablements: [],
});

// The minimum shape `assertCandidateSnapshotIsServable` needs from a snapshot routine: a
// stable id and an `enabled` flag. Only used by the skill/capability/webhook servability tests.
// `id`/`lineageId` default to the single-routine fixtures below; the multi-routine batching
// tests pass distinct values so several routines can coexist in one snapshot.
const routine = (
  enabled: boolean,
  id: string = routineId,
  lineageId: string = routineLineageId,
): AgentRevisionSnapshot["routines"][number] => ({
  id, agentId, lineageId, version: 1, enabled, name: "Returns",
  activation: { triggerDescription: "When a customer asks to return an order.", gateRef: null, priority: 1, reentryMode: "always" },
  slots: [], steps: [{ stableStepId: "ask", kind: "tool", instruction: "Look up the order.", toolRef: "removed-skill", actionType: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
  completionExport: { enabled: false, triggerKinds: [], destinationRef: "" },
  createdAt: new Date("2026-09-01T00:00:00.000Z"), updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

const rejectingValidator = (): RoutineServingValidator => ({
  validateForServing: vi.fn().mockResolvedValue({
    ok: false,
    diagnostics: [{ code: "unknown_skill", location: "step:ask", message: "unknown skill: step \"ask\" references \"removed-skill\", but no such skill exists." }],
  }),
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
  async findRevision(_workspaceId: string, _agentId: string, revisionId: string): Promise<AgentRevision | null> {
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

  it("replays an older successful publication without revalidating its historical routine dependencies", async () => {
    const repository = new InMemoryRevisionRepository();
    const publishedSnapshot = { ...snapshot("published v1"), routines: [routine(true)] };
    repository.revisions.set("candidate-1", publishedSnapshot);
    repository.publications.push({ revisionId: "candidate-1", idempotencyKey: "publish-1" });
    repository.publishedRevisionId = "published-2";
    vi.spyOn(repository, "findRevision").mockResolvedValue({
      id: "candidate-1",
      snapshot: publishedSnapshot,
      sourceDraftGeneration: 2,
      sourceBasePublishedRevisionId: "published-1",
      createdAt: new Date("2026-09-08T00:00:00.000Z"),
      publishedAt: new Date("2026-09-08T00:00:00.000Z"),
      publishedVersion: 1,
    });
    const validator = rejectingValidator();
    const service = new AgentRevisionService(repository, () => "candidate-2", validator);

    await expect(service.publish(workspaceId, agentId, null, {
      revisionId: "candidate-1", expectedDraftGeneration: 2, expectedPublishedRevisionId: "published-1", idempotencyKey: "publish-1",
    })).resolves.toMatchObject({ revisionId: "candidate-1", idempotentReplay: true });
    expect(validator.validateForServing).not.toHaveBeenCalled();
  });

  it("rejects creating a candidate whose enabled routine references a skill the workspace no longer has", async () => {
    // Old `restore` ran validateForServing before a routine could go live again; the agent
    // revision release is now the one gate, so createCandidate must run the same check.
    const repository = new InMemoryRevisionRepository();
    repository.draft = { ...repository.draft, snapshot: { ...snapshot("draft v1"), routines: [routine(true)] } };
    const validator = rejectingValidator();
    const service = new AgentRevisionService(repository, () => "candidate-1", validator);

    await expect(service.createCandidate(workspaceId, agentId, 2)).rejects.toMatchObject({
      statusCode: 422,
      code: "revision_invalid",
    });
    expect(validator.validateForServing).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ id: routineId }));
    expect(repository.revisions.has("candidate-1")).toBe(false);
  });

  it("does not run servability validation against a disabled routine", async () => {
    // A disabled routine cannot activate, so a stale skill reference on it cannot break a
    // conversation — parking a half-finished flow must not block the agent's release.
    const repository = new InMemoryRevisionRepository();
    repository.draft = { ...repository.draft, snapshot: { ...snapshot("draft v1"), routines: [routine(false)] } };
    const validator = rejectingValidator();
    const service = new AgentRevisionService(repository, () => "candidate-1", validator);

    await expect(service.createCandidate(workspaceId, agentId, 2)).resolves.toMatchObject({ id: "candidate-1" });
    expect(validator.validateForServing).not.toHaveBeenCalled();
  });

  it("rejects publishing a candidate whose enabled routine lost an available skill since it was created", async () => {
    const repository = new InMemoryRevisionRepository();
    repository.draft = { ...repository.draft, snapshot: { ...snapshot("draft v1"), routines: [routine(true)] } };
    const passingValidator: RoutineServingValidator = { validateForServing: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }) };
    const creatingService = new AgentRevisionService(repository, () => "candidate-1", passingValidator);
    await creatingService.createCandidate(workspaceId, agentId, 2);
    // The skill disappears between candidate creation and publish; a fresh service instance
    // stands in for the same workspace-scoped validator now reporting the reference as gone.
    const publishingService = new AgentRevisionService(repository, () => "candidate-1", rejectingValidator());

    await expect(publishingService.publish(workspaceId, agentId, null, {
      revisionId: "candidate-1",
      expectedDraftGeneration: repository.draft.generation,
      expectedPublishedRevisionId: "published-1",
      idempotencyKey: "publish-1",
    })).rejects.toMatchObject({ statusCode: 422, code: "revision_invalid" });
    expect(repository.publishedRevisionId).toBe("published-1");
  });

  it("runs one batched servability check for a draft with several enabled routines, not one call per routine", async () => {
    // Item 8: the workspace-scoped skill/context-variable state a servability check needs is the
    // same for every routine on one agent, so a validator that offers a batched capability must be
    // asked once for the whole snapshot rather than once per routine.
    const routineA = routine(true, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
    const routineB = routine(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "bbbbbbbb-bbbb-4bbb-8bbb-000000000001");
    const routineC = routine(true, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "cccccccc-cccc-4ccc-8ccc-000000000001");
    const repository = new InMemoryRevisionRepository();
    repository.draft = { ...repository.draft, snapshot: { ...snapshot("draft v1"), routines: [routineA, routineB, routineC] } };
    const routineBFailure: RoutineValidationResult = {
      ok: false,
      diagnostics: [{ code: "unknown_skill", location: "step:ask", message: "unknown skill: step \"ask\" references \"removed-skill\", but no such skill exists." }],
    };
    const passing: RoutineValidationResult = { ok: true, diagnostics: [] };
    const validateForServing = vi.fn();
    const validateManyForServing = vi.fn(async (_workspaceId: string, routines: readonly { id: string }[]) =>
      new Map(routines.map((candidate) => [candidate.id, candidate.id === routineB.id ? routineBFailure : passing] as const)));
    const validator: RoutineServingValidator = { validateForServing, validateManyForServing };
    const service = new AgentRevisionService(repository, () => "candidate-1", validator);

    try {
      await service.createCandidate(workspaceId, agentId, 2);
      expect.unreachable("expected createCandidate to reject");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 422, code: "revision_invalid" });
      expect((error as { details?: { diagnostics?: unknown[] } }).details?.diagnostics).toEqual([
        expect.objectContaining({ routineId: routineB.id, code: "unknown_skill" }),
      ]);
    }

    expect(validateManyForServing).toHaveBeenCalledTimes(1);
    expect(validateManyForServing).toHaveBeenCalledWith(workspaceId, expect.arrayContaining([
      expect.objectContaining({ id: routineA.id }),
      expect.objectContaining({ id: routineB.id }),
      expect.objectContaining({ id: routineC.id }),
    ]));
    expect(validateForServing).not.toHaveBeenCalled();
    expect(repository.revisions.has("candidate-1")).toBe(false);
  });

  it("falls back to one validateForServing call per routine when the validator does not offer a batched capability", async () => {
    // A narrower test double (or a future caller) may implement only the single-routine method;
    // the per-routine Promise.all path must still work for every enabled routine in the snapshot.
    const routineA = routine(true, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
    const routineB = routine(true, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "bbbbbbbb-bbbb-4bbb-8bbb-000000000001");
    const repository = new InMemoryRevisionRepository();
    repository.draft = { ...repository.draft, snapshot: { ...snapshot("draft v1"), routines: [routineA, routineB] } };
    const validateForServing = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const validator: RoutineServingValidator = { validateForServing };
    const service = new AgentRevisionService(repository, () => "candidate-1", validator);

    await expect(service.createCandidate(workspaceId, agentId, 2)).resolves.toMatchObject({ id: "candidate-1" });

    expect(validateForServing).toHaveBeenCalledTimes(2);
    expect(validateForServing).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ id: routineA.id }));
    expect(validateForServing).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ id: routineB.id }));
  });
});
