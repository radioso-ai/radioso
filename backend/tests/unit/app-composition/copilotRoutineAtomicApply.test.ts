import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/shared/infra/kysely/sqlHelpers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/shared/infra/kysely/sqlHelpers.js")>(),
  // The port takes a serializing advisory lock before every write; a fake `Db` has no driver to
  // run it against, so stub it to a no-op and exercise only the conflict-translation this test
  // targets.
  transactionAdvisoryLock: vi.fn(() => ({ execute: vi.fn(async () => undefined) })),
}));

import { createRoutineMcpApplyPort } from "../../../src/app/composition/copilotRoutineAtomicApply.js";
import { RoutineDefinitionRepository } from "../../../src/db/repositories/routineDefinitionRepository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";

// Construction-only fake: every test replaces the repository method the port calls via
// vi.spyOn, so this stands in for a live transaction without ever running a real query.
const fakeDb = { isTransaction: true } as unknown as Db;

const workspaceId = "workspace-1";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const baseInput = {
  workspaceId,
  agentId,
  proposalId: "proposal-1",
  executionInvocationId: "receipt-1",
  operatorUserId: "operator-1",
  claimedAt: new Date("2026-09-02T00:00:00Z"),
};
const validateScopedReferences = vi.fn(async () => undefined);
const port = createRoutineMcpApplyPort(fakeDb, { validateScopedReferences });

const applyAndCatch = (input: Parameters<ReturnType<typeof createRoutineMcpApplyPort>["apply"]>[0]): Promise<unknown> =>
  port.apply(input).then(
    () => { throw new Error("expected apply to reject"); },
    (error: unknown) => error,
  );

describe("createRoutineMcpApplyPort conflict translation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws a durable conflict when a reviewed create collides on name and version", async () => {
    vi.spyOn(RoutineDefinitionRepository.prototype, "createDraftWithAgentDraft").mockRejectedValue({
      code: "23505",
      constraint: "routine_definition_agent_id_name_version_key",
      message: 'duplicate key value violates unique constraint "routine_definition_agent_id_name_version_key"',
    });

    const error = await applyAndCatch({ ...baseInput, operation: "create", draft: { name: "Returns" } as never });

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("conflict");
  });

  it("throws a durable conflict when a reviewed update loses its version guard", async () => {
    vi.spyOn(RoutineDefinitionRepository.prototype, "updateDraftWithAgentDraft").mockRejectedValue(
      new Error(`routine_definition_update_conflict:${routineId}`),
    );

    const error = await applyAndCatch({
      ...baseInput,
      operation: "update",
      routineId,
      draft: { name: "Returns" } as never,
      expectedUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      removedNodeIds: [],
      removedSlotIds: [],
    });

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("conflict");
  });

  it("throws a durable conflict when a reviewed delete's version guard misses", async () => {
    vi.spyOn(RoutineDefinitionRepository.prototype, "deleteDraftWithAgentDraft").mockResolvedValue({ outcome: "conflict" });
    const settle = vi.spyOn(CopilotRepository.prototype, "settleMcpAppliedOn");

    const error = await applyAndCatch({
      ...baseInput,
      operation: "delete",
      routineId,
      expectedUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      removedNodeIds: [],
      removedSlotIds: [],
    });

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("conflict");
    // The transaction rolled back before the receipt could settle on a write that never happened.
    expect(settle).not.toHaveBeenCalled();
  });

  it("keeps a receipt-settlement race an unclassified plain Error, not a stale conflict", async () => {
    vi.spyOn(RoutineDefinitionRepository.prototype, "createDraftWithAgentDraft").mockResolvedValue({ id: "routine-created" } as never);
    vi.spyOn(CopilotRepository.prototype, "settleMcpAppliedOn").mockResolvedValue(false);

    const error = await applyAndCatch({ ...baseInput, operation: "create", draft: { name: "Returns" } as never });

    // `reviewed_proposal_receipt_conflict` means another claimant owns the receipt, not that the
    // routine moved - it must stay unclassified rather than reading as `isStale`.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as Error).message).toBe("reviewed_proposal_receipt_conflict");
  });
});
