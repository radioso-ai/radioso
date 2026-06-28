import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvalCase, EvalSnapshot } from "../../src/modules/eval/domain/types.js";
import { EvalCaseService } from "../../src/modules/eval/services/evalCaseService.js";
import { createInMemoryEvalRepository } from "../support/inMemoryEvalRepository.js";

const now = "2026-01-01T00:00:00.000Z";

const snapshot = (workspaceId: string, id = randomUUID()): EvalSnapshot => ({
  id,
  workspaceId,
  sourceConversationId: randomUUID(),
  sourceMessageId: null,
  fidelity: "full",
  messages: [],
  originalInstructionBlock: null,
  originalModelId: null,
  originalRetrievalSettings: null,
  originalRetrievalResult: null,
  originalAgent: null,
  originalAgentConfig: null,
  sourceAgentId: null,
  originalRoutineState: null,
  capturedAt: now,
  capturedBy: null,
});

const evalCase = (workspaceId: string, snapshotId: string, id = randomUUID()): EvalCase => ({
  id,
  workspaceId,
  snapshotId,
  name: "Delete me",
  assertions: [],
  status: "pending",
  lastRunId: null,
  createdAt: now,
  updatedAt: now,
});

describe("EvalCaseService.delete", () => {
  it("deletes an eval case from the owning workspace", async () => {
    const workspaceId = randomUUID();
    const snap = snapshot(workspaceId);
    const existing = evalCase(workspaceId, snap.id);
    const repository = createInMemoryEvalRepository({ snapshots: [snap], cases: [existing] });
    const service = new EvalCaseService(repository);

    await service.delete(workspaceId, existing.id);

    await expect(service.getWithRuns(workspaceId, existing.id)).rejects.toMatchObject({
      code: "not_found",
      message: "Eval case not found",
    });
  });

  it("does not delete a case from another workspace", async () => {
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const snap = snapshot(workspaceId);
    const existing = evalCase(workspaceId, snap.id);
    const repository = createInMemoryEvalRepository({ snapshots: [snap], cases: [existing] });
    const service = new EvalCaseService(repository);

    await expect(service.delete(otherWorkspaceId, existing.id)).rejects.toMatchObject({
      code: "not_found",
      message: "Eval case not found",
    });

    await expect(service.getWithRuns(workspaceId, existing.id)).resolves.toMatchObject({
      id: existing.id,
    });
  });
});
