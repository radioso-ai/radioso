import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSkillMcpApplyPort } from "../../../src/app/composition/copilotAgentSkillAtomicApply.js";
import { AgentSkillRepository } from "../../../src/modules/agentSkills/repository.js";
import { CopilotRepository } from "../../../src/db/repositories/copilotRepository.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";

// Construction-only fake: every test replaces the repository method the port calls via
// vi.spyOn, so this stands in for a live transaction without ever running a real query.
const fakeDb = { isTransaction: true } as unknown as Db;

const baseInput = {
  workspaceId: "workspace-1",
  agentId: "11111111-1111-4111-8111-111111111111",
  skillId: "22222222-2222-4222-8222-222222222222",
  expectedUpdatedAt: new Date("2026-01-01T00:00:00Z"),
  target: { kind: "document", id: null },
  config: {},
  invocationMode: "default_answer" as never,
  enabled: true,
  proposalId: "proposal-1",
  executionInvocationId: "receipt-1",
  operatorUserId: "operator-1",
  claimedAt: new Date("2026-09-02T00:00:00Z"),
};
const port = createAgentSkillMcpApplyPort(fakeDb);

const applyAndCatch = (): Promise<unknown> =>
  port.apply(baseInput).then(
    () => { throw new Error("expected apply to reject"); },
    (error: unknown) => error,
  );

describe("createAgentSkillMcpApplyPort conflict translation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws a durable conflict when a reviewed skill update loses its version guard", async () => {
    vi.spyOn(AgentSkillRepository.prototype, "update").mockResolvedValue(null);

    const error = await applyAndCatch();

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("conflict");
  });

  it("keeps a receipt-settlement race an unclassified plain Error, not a stale conflict", async () => {
    vi.spyOn(AgentSkillRepository.prototype, "update").mockResolvedValue({ id: baseInput.skillId } as never);
    vi.spyOn(CopilotRepository.prototype, "settleMcpAppliedOn").mockResolvedValue(false);

    const error = await applyAndCatch();

    // `reviewed_proposal_receipt_conflict` means another claimant owns the receipt, not that the
    // skill moved - it must stay unclassified rather than reading as `isStale`.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as Error).message).toBe("reviewed_proposal_receipt_conflict");
  });
});
