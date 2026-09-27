import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAgentSettingsReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/agentSettingsReviewedPreparation.js";
import { createIngestionSettingsReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/ingestionSettingsReviewedPreparation.js";

const agentId = randomUUID();
const context = {
  workspaceId: randomUUID(), accountId: randomUUID(), operatorUserId: randomUUID(), surface: "mcp" as const,
  operatorMcpInvocationId: randomUUID(), operatorMcpGrantId: randomUUID(), operatorMcpClientId: randomUUID(),
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const proposalDependencies = () => ({
  proposalRepository: { createProposal: vi.fn(async (input) => ({ id: randomUUID(), ...input })) },
  proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
  proposalAdapters: [], auditService: { record: vi.fn() }, now: () => new Date("2026-09-26T10:00:00.000Z"),
});

describe("reviewed settings preparation", () => {
  it("persists one multi-field agent review with its owner field fence and lifecycle", async () => {
    const deps = proposalDependencies();
    const prepareFieldsProposal = vi.fn(async () => ({
      targetAgentId: agentId, agentName: "Support", normalizedPatch: { name: "Help", customInstruction: "Be concise." },
      expectedFields: [{ key: "name", value: "Support" }, { key: "customInstruction", value: "" }],
      changes: [{ key: "name", current: "Support", proposed: "Help", lifecycle: "live" as const, reach: false }, { key: "customInstruction", current: "", proposed: "Be concise.", lifecycle: "agent_draft" as const, reach: false }], unchanged: [],
    }));
    const descriptor = createAgentSettingsReviewedPreparationTool({ ...deps, agentSettings: { prepareFieldsProposal, readFieldProposalVersion: vi.fn(async () => "fields:agent") } as never });

    const output = await descriptor.createTool(context).invoke({ agentId, patch: { name: "Help", customInstruction: "Be concise." } }, {} as never);

    expect(prepareFieldsProposal).toHaveBeenCalledWith(context.workspaceId, agentId, { name: "Help", customInstruction: "Be concise." });
    expect(output).toMatchObject({ review: { effects: { publicationRequired: true, liveKeys: ["name"], draftKeys: ["customInstruction"] } } });
    expect(deps.proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType: "agent_setting", targetRef: { agentId, expectedFields: expect.any(Array) }, reviewDigest: expect.any(String), expiresAt: new Date("2026-09-26T10:15:00.000Z") }));
  });

  it("persists ingestion review from the owner's normalized surface and changed-field fence", async () => {
    const deps = proposalDependencies();
    const prepareFieldProposal = vi.fn(async () => ({
      normalizedPatch: { chunkingStrategy: "fixed_window", fixedWindowChunkSize: 1_500, fixedWindowChunkOverlap: 100, structuredMinChunkSize: 200, structuredMaxChunkSize: 2_000 },
      expected: { fixedWindowChunkSize: 1_000 }, display: { current: { fixedWindowChunkSize: 1_000 }, proposed: { fixedWindowChunkSize: 1_500 } },
    }));
    const descriptor = createIngestionSettingsReviewedPreparationTool({ ...deps, ingestionSettings: { prepareFieldProposal, readFieldProposalVersion: vi.fn(async () => "fields:ingestion") } as never });

    const output = await descriptor.createTool(context).invoke({ fixedWindowChunkSize: 1_500 }, {} as never);

    expect(output).toMatchObject({ review: { changes: [{ field: "fixedWindowChunkSize", before: 1_000, after: 1_500 }], effect: { existingDocuments: "unchanged_until_reprocessed" } } });
    expect(deps.proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType: "ingestion_settings", targetRef: { expectedFields: { fixedWindowChunkSize: 1_000 } }, reviewDigest: expect.any(String) }));
  });
});
