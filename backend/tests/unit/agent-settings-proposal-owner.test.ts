import { describe, expect, it, vi } from "vitest";

import { AgentService, unpublishedAgentPublicIdentity, type AgentRecord } from "../../src/modules/agents/public.js";

const agent = (): AgentRecord => ({
  ...unpublishedAgentPublicIdentity(), id: "agent-1", workspaceId: "workspace-1", name: "Support", internalName: "support",
  greetingInstruction: "Hello", assistantDefaultLocale: null, proactiveGreetingEnabled: false,
  suggestedQuestionsEnabled: true, assistantLinkUtmEnabled: true, citationDisplayEnabled: true,
  contactRequestsEnabled: false, webhookExportsEnabled: false, handoffOnRetrievalMiss: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null }, customInstruction: "", retrievalEnabled: true,
  sourceScope: { mode: "all" }, skillSettings: {}, chatModelOverride: null, logo: null,
  theme: { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null }, publicDescription: "", agentCardEnabled: false,
  publicAgentAccessEnabled: false, walkInConversationsPerHour: null,
  surfaceSettings: { authenticatedChat: { enabled: true }, anonymousChat: { enabled: false, token: null }, websiteEmbed: { enabled: false, token: null, allowedOrigins: [], launcherLabel: "Ask", launcherPosition: "bottom-right", theme: { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" }, copy: {}, expertOverrides: {} }, extensions: {} },
  authoredDirectives: [], createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("AgentService reviewed settings owner port", () => {
  it("normalizes several fields and classifies draft lifecycle and reach in the owner", async () => {
    const service = new AgentService({} as never, {} as never);
    vi.spyOn(service, "get").mockResolvedValue({ ...agent(), isDefault: false, assistantBootstrapActive: false });

    const prepared = await service.prepareFieldsProposal("workspace-1", "agent-1", {
      name: "  Help Desk  ", customInstruction: "  Be concise.  ", agentCardEnabled: true,
    });

    expect(prepared.normalizedPatch).toMatchObject({ name: "Help Desk", customInstruction: "Be concise.", agentCardEnabled: true });
    expect(prepared.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "customInstruction", lifecycle: "agent_draft", reach: false }),
      expect.objectContaining({ key: "agentCardEnabled", lifecycle: "live", reach: true }),
    ]));
  });

  it("does not invoke the commit hook after a stale field CAS", async () => {
    const service = new AgentService({} as never, {} as never);
    const apply = vi.spyOn(service, "applyProposalPatch").mockResolvedValue({ outcome: "changed", fields: ["name"] });
    const hook = vi.fn();

    await expect(service.applyFieldProposal("workspace-1", {
      targetAgentId: "agent-1", normalizedPatch: { name: "Help" }, expectedFields: [{ key: "name", value: "Support" }],
    }, { onCommitted: hook })).resolves.toEqual({ status: "changed", fields: ["name"] });

    expect(apply).toHaveBeenCalledWith("workspace-1", "agent-1", { name: "Help" }, expect.objectContaining({ onCommitted: hook }));
    expect(hook).not.toHaveBeenCalled();
  });

  it("keeps the hook inside the successful owner apply boundary", async () => {
    const service = new AgentService({} as never, {} as never);
    const hook = vi.fn(async () => undefined);
    vi.spyOn(service, "applyProposalPatch").mockImplementation(async (_workspaceId, _agentId, _patch, guard) => {
      await guard.onCommitted?.({} as never, { agentId: "agent-1" });
      return { outcome: "applied", previous: agent(), agent: agent() };
    });

    await expect(service.applyFieldProposal("workspace-1", {
      targetAgentId: "agent-1", normalizedPatch: { name: "Help" }, expectedFields: [{ key: "name", value: "Support" }],
    }, { onCommitted: hook })).resolves.toEqual({ status: "applied" });

    expect(hook).toHaveBeenCalledTimes(1);
  });
});
