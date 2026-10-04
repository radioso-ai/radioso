import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createDirectiveReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/directiveReviewedPreparation.js";

const agentId = randomUUID();
const directiveId = randomUUID();
const context = { workspaceId: randomUUID(), accountId: randomUUID(), operatorUserId: randomUUID(), surface: "mcp" as const, operatorMcpInvocationId: randomUUID(), operatorMcpGrantId: randomUUID(), operatorMcpClientId: randomUUID(), currentAuthorization: { hasAllPermissions: vi.fn(async () => true) }, pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] } };
const directive = { id: directiveId, agentId, name: "quote-primary", condition: { kind: "always" as const }, action: "Quote the source.", priority: null, excludes: [], tags: [], surfaces: [], enabled: true, requiredCapabilities: [], dependsOn: [], routes: [], description: null, binding: null, lifecycle: null, metadata: {}, createdAt: new Date(), updatedAt: new Date() };

const dependencies = () => {
  const previewChange = vi.fn(async (_workspaceId: string, _agentId: string, input: { kind: string }) => ({ before: input.kind === "create" ? null : directive, after: input.kind === "remove" ? null : { ...directive, enabled: input.kind === "set_enabled" ? false : true }, coherence: { status: input.kind === "remove" ? "not_checked" as const : "coherent" as const, conflicts: [], rationale: "Coherent." }, referencedBy: [], referencedByTotal: 0, drafting: "verbatim" as const, irreversible: input.kind === "remove", effect: { exposure: "draft" as const, reversibility: input.kind === "remove" ? "irreversible" as const : "reversible" as const, metered: false }, versionToken: "2026-09-26T09:00:00.000Z" }));
  return {
    proposalRepository: { createProposal: vi.fn(async (input) => ({ id: randomUUID(), ...input })) }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, proposalAdapters: [], auditService: { record: vi.fn() }, now: () => new Date("2026-09-26T10:00:00.000Z"), appBaseUrl: "https://app.radioso.ai",
    directiveAuthor: { draftForProposal: vi.fn(async () => ({ draft: { directive: { name: "quote-primary", condition: { kind: "always" as const }, action: "Use **this exact text**.", excludes: [], tags: [], surfaces: [] } }, versionToken: "2026-09-26T09:00:00.000Z", current: null, drafting: "verbatim" as const })) }, directives: { previewChange },
  };
};

describe("reviewed directive preparation", () => {
  it.each([
    { kind: "create", extra: { name: "quote-primary", condition: { kind: "always" }, action: "Use **this exact text**." }, directiveId: null, requirement: "conversation" },
    { kind: "edit", extra: { directiveId, name: "quote-primary", condition: { kind: "always" }, action: "Use **this exact text**." }, directiveId, requirement: "conversation" },
    { kind: "set_enabled", extra: { directiveId, enabled: false }, directiveId, requirement: "conversation" },
    { kind: "remove", extra: { directiveId }, directiveId, requirement: "signed_in_approval" },
  ] as const)("persists a $kind review with its owner fence and its owner's confirmation requirement", async ({ kind, extra, directiveId: expectedDirectiveId, requirement }) => {
    const deps = dependencies();
    const tool = createDirectiveReviewedPreparationTool(deps as never).createTool(context);
    const output = await tool.invoke({ kind, agentId, ...extra }, {} as never) as { review: unknown; confirmation: { requirement: string; approvalUrl?: string } };
    expect(output.review).toMatchObject({ kind, target: { agentId, directiveId: expectedDirectiveId }, lifecycle: "agent_draft", publicationRequired: true, irreversible: kind === "remove" });
    expect(deps.proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType: "directive", versionToken: "2026-09-26T09:00:00.000Z", reviewDigest: expect.any(String), expiresAt: new Date("2026-09-26T10:15:00.000Z") }));
    // Removal is permanent, so it alone among directive operations requires the signed-in approval
    // the owner's `effect` declares; create/edit/set_enabled stay chat-confirmable drafts.
    expect(output.confirmation.requirement).toBe(requirement);
    if (requirement === "signed_in_approval") expect(output.confirmation.approvalUrl).toMatch(/^https:\/\/app\.radioso\.ai\/oauth\/operator-mcp\/proposal\//);
    else expect(output.confirmation.approvalUrl).toBeUndefined();
  });
});
