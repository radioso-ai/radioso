import { describe, expect, it, vi } from "vitest";

import { lateBoundReviewedProposalPorts } from "../../../src/app/composition/lateBoundReviewedProposals.js";

const service = () => ({
  executeMcpReviewedProposal: vi.fn(async () => ({ status: "executed" }) as never),
  getMcpReviewedProposal: vi.fn(async () => null as never),
  isDashboardReviewedProposal: vi.fn(async () => true),
  cancelMcpReviewedProposal: vi.fn(async () => ({ status: "dismissed" as const })),
  getProposalDetail: vi.fn(async () => null),
});

describe("lateBoundReviewedProposalPorts", () => {
  it("refuses every call while the copilot service is not built yet", async () => {
    const ports = lateBoundReviewedProposalPorts(() => undefined);
    const input = {} as never;

    await expect(ports.reviewedProposalExecution.executeMcpReviewedProposal(input)).rejects.toThrow("Operator Copilot execution service is not initialized");
    await expect(ports.reviewedProposalOutcome.getMcpReviewedProposal(input)).rejects.toThrow("Operator Copilot execution service is not initialized");
    await expect(ports.reviewedProposalOutcome.isDashboardReviewedProposal(input)).rejects.toThrow("Operator Copilot proposal service is not initialized");
    await expect(ports.cancelReviewedProposal.cancelMcpReviewedProposal(input)).rejects.toThrow("Operator Copilot execution service is not initialized");
    await expect(ports.proposalDetail.getProposalDetail(input)).rejects.toThrow("Operator Copilot proposal service is not initialized");
  });

  it("reaches the service built after the ports, at call time", async () => {
    const holder: { built?: ReturnType<typeof service> } = {};
    const ports = lateBoundReviewedProposalPorts(() => holder.built);
    const built = service();
    holder.built = built;
    const input = { workspaceId: "ws-1" } as never;

    await ports.reviewedProposalExecution.executeMcpReviewedProposal(input);
    await ports.reviewedProposalOutcome.getMcpReviewedProposal(input);
    expect(await ports.reviewedProposalOutcome.isDashboardReviewedProposal(input)).toBe(true);
    expect(await ports.cancelReviewedProposal.cancelMcpReviewedProposal(input)).toEqual({ status: "dismissed" });
    await ports.proposalDetail.getProposalDetail(input);

    for (const method of Object.values(built)) {
      expect(method).toHaveBeenCalledWith(input);
    }
  });
});
