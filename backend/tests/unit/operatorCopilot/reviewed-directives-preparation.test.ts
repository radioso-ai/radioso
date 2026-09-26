import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createDirectiveReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/directiveReviewedPreparation.js";

const agentId = randomUUID();
const directiveId = randomUUID();
const context = { workspaceId: randomUUID(), accountId: randomUUID(), operatorUserId: randomUUID(), surface: "mcp" as const, operatorMcpInvocationId: randomUUID(), operatorMcpGrantId: randomUUID(), operatorMcpClientId: randomUUID(), currentAuthorization: { hasAllPermissions: vi.fn(async () => true) }, pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] } };
const directive = { id: directiveId, agentId, name: "quote-primary", condition: { kind: "always" as const }, action: "Quote the source.", priority: null, excludes: [], tags: [], surfaces: [], enabled: true, requiredCapabilities: [], dependsOn: [], routes: [], description: null, binding: null, lifecycle: null, metadata: {}, createdAt: new Date(), updatedAt: new Date() };

const dependencies = () => {
  const previewChange = vi.fn(async (_workspaceId: string, _agentId: string, input: { kind: string }) => ({ before: input.kind === "create" ? null : directive, after: input.kind === "remove" ? null : { ...directive, enabled: input.kind === "set_enabled" ? false : true }, coherence: { status: input.kind === "remove" ? "not_checked" as const : "coherent" as const, conflicts: [], rationale: "Coherent." }, referencedBy: [], referencedByTotal: 0, drafting: "verbatim" as const, irreversible: input.kind === "remove", versionToken: "2026-09-26T09:00:00.000Z" }));
  return {
    proposalRepository: { createProposal: vi.fn(async (input) => ({ id: randomUUID(), ...input })) }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, proposalAdapters: [], auditService: { record: vi.fn() }, now: () => new Date("2026-09-26T10:00:00.000Z"),
    directiveAuthor: { draftForProposal: vi.fn(async () => ({ draft: { directive: { name: "quote-primary", condition: { kind: "always" as const }, action: "Use **this exact text**.", excludes: [], tags: [], surfaces: [] } }, versionToken: "2026-09-26T09:00:00.000Z", current: null, drafting: "verbatim" as const })) }, directives: { previewChange },
  };
};

describe("reviewed directive preparation", () => {
  it.each([
    { kind: "create", extra: { name: "quote-primary", condition: { kind: "always" }, action: "Use **this exact text**." }, directiveId: null },
    { kind: "edit", extra: { directiveId, name: "quote-primary", condition: { kind: "always" }, action: "Use **this exact text**." }, directiveId },
    { kind: "set_enabled", extra: { directiveId, enabled: false }, directiveId },
    { kind: "remove", extra: { directiveId }, directiveId },
  ] as const)("persists a $kind review with its owner fence", async ({ kind, extra, directiveId: expectedDirectiveId }) => {
    const deps = dependencies();
    const tool = createDirectiveReviewedPreparationTool(deps as never).createTool(context);
    const output = await tool.invoke({ kind, agentId, ...extra }, {} as never);
    expect(output.review).toMatchObject({ kind, target: { agentId, directiveId: expectedDirectiveId }, lifecycle: "agent_draft", publicationRequired: true, irreversible: kind === "remove" });
    expect(deps.proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType: "directive", versionToken: "2026-09-26T09:00:00.000Z", reviewDigest: expect.any(String), expiresAt: new Date("2026-09-26T10:15:00.000Z") }));
  });
});
