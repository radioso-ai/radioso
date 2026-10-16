import { describe, expect, it, vi } from "vitest";

import { AgentService, defaultAgentVoiceSettings, unpublishedAgentPublicIdentity, type AgentRecord } from "../../src/modules/agents/public.js";
import { reviewedConfirmationRequirement } from "../../src/modules/operatorCopilot/reviewedOperation.js";

const agent = (): AgentRecord => ({
  ...unpublishedAgentPublicIdentity(), voice: defaultAgentVoiceSettings(), mechanicsReplies: {}, id: "agent-1", workspaceId: "workspace-1", name: "Support", internalName: "support",
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
    // Design §4.4 (mixed operations): one live field among several changed keys takes the whole
    // operation's owner-declared effect to `live`, which the one policy rule turns into
    // signed_in_approval - the copilot layer never re-derives this from the field list itself.
    expect(prepared.effect).toEqual({ exposure: "live", reversibility: "reversible", metered: false });
    expect(reviewedConfirmationRequirement(prepared.effect)).toBe("signed_in_approval");
  });

  it("declares a draft effect, and the conversation tier, when every changed key is an agent draft field", async () => {
    const service = new AgentService({} as never, {} as never);
    vi.spyOn(service, "get").mockResolvedValue({ ...agent(), isDefault: false, assistantBootstrapActive: false });

    const prepared = await service.prepareFieldsProposal("workspace-1", "agent-1", { customInstruction: "Be concise." });

    expect(prepared.changes).toEqual([expect.objectContaining({ key: "customInstruction", lifecycle: "agent_draft" })]);
    expect(prepared.effect).toEqual({ exposure: "draft", reversibility: "reversible", metered: false });
    expect(reviewedConfirmationRequirement(prepared.effect)).toBe("conversation");
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

const storedVoice = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: [], check: ["Let me check that for you, it only takes a moment."] },
    it: { acknowledge: [], check: ["Controllo subito per te, ci vorrà solo un momento."] },
  },
  fallbackLine: { en: "Sorry, this is taking much longer than it should, could you ask me again?" },
  runtime: { vendor: "elevenlabs" as const, agentId: "agent_01jxk2v9qbe8n7r6t5w4" },
};
const storedMechanics = {
  en: { greeting: ["Hi! How can I help?"], thanks: [], farewell: ["Goodbye!"], acknowledgement: [] },
};
const serviceWith = (overrides: Partial<AgentRecord> = {}) => {
  const service = new AgentService({} as never, {} as never);
  vi.spyOn(service, "get").mockResolvedValue({ ...agent(), ...overrides, isDefault: false, assistantBootstrapActive: false });
  return service;
};

describe("AgentService voice and mechanics replies proposals", () => {
  it("prepares a voice block as one live setting that replaces the stored block whole", async () => {
    const service = serviceWith({ voice: storedVoice });
    const proposed = {
      enabled: true,
      bridgeLines: { en: { acknowledge: ["Thanks, I have noted that, so let me take the next step."], check: [] } },
      fallbackLine: {},
      runtime: null,
    };

    const prepared = await service.prepareFieldProposal("workspace-1", "agent-1", { settingKey: "voice", value: proposed });

    // The Italian lines and the English fallback are gone: the proposal is the new block, not a merge.
    expect(prepared.normalizedPatch).toEqual({ voice: proposed });
    expect(prepared.expected).toEqual({ key: "voice", value: storedVoice });
    expect(prepared.display).toEqual({ current: storedVoice, proposed });
  });

  it("prepares a mechanics replies block that replaces the stored block whole", async () => {
    const service = serviceWith({ mechanicsReplies: storedMechanics });
    const proposed = { it: { greeting: ["Ciao! Come posso aiutarti?"], thanks: ["Prego!"], farewell: [], acknowledgement: [] } };

    const prepared = await service.prepareFieldProposal("workspace-1", "agent-1", { settingKey: "mechanicsReplies", value: proposed });

    expect(prepared.normalizedPatch).toEqual({ mechanicsReplies: proposed });
    expect(prepared.display).toEqual({ current: storedMechanics, proposed });
  });

  it("names the failing field when a voice block is invalid", async () => {
    const service = serviceWith();

    await expect(service.prepareFieldProposal("workspace-1", "agent-1", {
      settingKey: "voice",
      value: { enabled: true, bridgeLines: { en: { acknowledge: [], check: ["a".repeat(201)] } }, fallbackLine: {}, runtime: null },
    })).rejects.toThrow(/Invalid voice setting value.*bridgeLines\.en\.check\.0/);
    await expect(service.prepareFieldProposal("workspace-1", "agent-1", {
      settingKey: "voice",
      value: { enabled: true, bridgeLines: {} },
    })).rejects.toThrow(/Invalid voice setting value.*fallbackLine/);
  });

  it("names the failing field when a mechanics replies block is invalid", async () => {
    const service = serviceWith();

    await expect(service.prepareFieldProposal("workspace-1", "agent-1", {
      settingKey: "mechanicsReplies",
      value: { en: { greeting: ["Hi!"], thanks: [], acknowledgement: [] } },
    })).rejects.toThrow(/Invalid mechanicsReplies setting value.*en\.farewell/);
    await expect(service.prepareFieldProposal("workspace-1", "agent-1", {
      settingKey: "mechanicsReplies",
      value: { english: { greeting: ["Hi!"], thanks: [], farewell: [], acknowledgement: [] } },
    })).rejects.toThrow(/Invalid mechanicsReplies setting value.*english/);
  });

  it("carries both blocks in one reviewed patch as live changes that do not alter reach", async () => {
    const service = serviceWith({ voice: storedVoice, mechanicsReplies: storedMechanics });
    const voice = { ...storedVoice, enabled: false };
    const mechanicsReplies = {};

    const prepared = await service.prepareFieldsProposal("workspace-1", "agent-1", { voice, mechanicsReplies });

    expect(prepared.normalizedPatch).toEqual({ voice, mechanicsReplies });
    expect(prepared.changes).toEqual([
      { key: "voice", current: storedVoice, proposed: voice, lifecycle: "live", reach: false },
      { key: "mechanicsReplies", current: storedMechanics, proposed: mechanicsReplies, lifecycle: "live", reach: false },
    ]);
    expect(prepared.effect).toEqual({ exposure: "live", reversibility: "reversible", metered: false });
  });

  it("reads the stored block with its languages in another order as unchanged", async () => {
    // Postgres jsonb returns object keys in its own order, so key order carries no meaning here.
    const service = serviceWith({ voice: storedVoice, mechanicsReplies: storedMechanics });
    const reordered = {
      runtime: storedVoice.runtime,
      fallbackLine: storedVoice.fallbackLine,
      bridgeLines: { it: storedVoice.bridgeLines.it, en: storedVoice.bridgeLines.en },
      enabled: true,
    };

    const prepared = await service.prepareFieldsProposal("workspace-1", "agent-1", { voice: reordered, name: "Help Desk" });

    expect(prepared.changes.map((change) => change.key)).toEqual(["name"]);
    expect(prepared.unchanged).toEqual(["voice"]);
    await expect(service.prepareFieldsProposal("workspace-1", "agent-1", { voice: reordered })).rejects.toThrow("already hold these values");
  });

  it("bounds the failing path it names, however long the offending key", async () => {
    const service = serviceWith();
    const hugeKey = "x".repeat(50_000);

    const error: Error = await service.prepareFieldProposal("workspace-1", "agent-1", {
      settingKey: "mechanicsReplies",
      value: { [hugeKey]: { greeting: [], thanks: [], farewell: [], acknowledgement: [] } },
    }).then(() => new Error("expected a rejection"), (caught: unknown) => caught as Error);

    const path = /^Invalid mechanicsReplies setting value at (x+…): /.exec(error.message)?.[1];
    expect(path).toHaveLength(200);
    expect(error.message.length).toBeLessThan(500);
  });

  it("cuts a long path between characters, never inside one", async () => {
    const service = serviceWith();
    // 😀 is two UTF-16 units: a cut at an odd unit would leave half of one.
    const emojiKey = `x${"😀".repeat(150)}`;

    const error: Error = await service.prepareFieldProposal("workspace-1", "agent-1", {
      settingKey: "mechanicsReplies",
      value: { [emojiKey]: { greeting: [], thanks: [], farewell: [], acknowledgement: [] } },
    }).then(() => new Error("expected a rejection"), (caught: unknown) => caught as Error);

    const path = /^Invalid mechanicsReplies setting value at (\S+…): /u.exec(error.message)?.[1] ?? "";
    expect(path.length).toBeLessThanOrEqual(200);
    // With the u flag a whole pair is one code point, so \p{Cs} matches only half of one.
    expect(/\p{Cs}/u.test(path)).toBe(false);
    expect(path.endsWith("😀…")).toBe(true);
  });

  it("applies a reviewed voice patch fenced on the block it replaces", async () => {
    const service = new AgentService({} as never, {} as never);
    const apply = vi.spyOn(service, "applyProposalPatch").mockResolvedValue({ outcome: "applied", previous: agent(), agent: agent() });
    const voice = { ...storedVoice, enabled: false };

    await expect(service.applyFieldProposal("workspace-1", {
      targetAgentId: "agent-1", normalizedPatch: { voice }, expectedFields: [{ key: "voice", value: storedVoice }],
    })).resolves.toEqual({ status: "applied" });

    expect(apply).toHaveBeenCalledWith("workspace-1", "agent-1", { voice }, expect.objectContaining({ expectedFields: [{ key: "voice", value: storedVoice }] }));
  });

  it("reads the version and display of either block for a proposal card", async () => {
    const service = serviceWith({ voice: storedVoice, mechanicsReplies: storedMechanics });

    await expect(service.readFieldProposalDisplay("workspace-1", "agent-1", "voice")).resolves.toEqual(storedVoice);
    await expect(service.readFieldProposalVersion("workspace-1", "agent-1", { keys: ["voice", "mechanicsReplies"] })).resolves.toEqual(expect.any(String));
  });
});
