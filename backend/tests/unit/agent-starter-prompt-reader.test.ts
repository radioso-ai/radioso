import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { RevisionGreetingStarterPromptReader } from "../../src/modules/chat/services/agentStarterPromptReader.js";
import { AgentService, type AgentRevision } from "../../src/modules/agents/public.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { InMemoryAgentRepository, InMemoryWorkspaceRepository } from "../support/fakes.js";

const buildRevision = (
  greeting: { exactWordsEnabled: boolean; exactContent: { chips: string[]; variants: Array<{ locale: string; body: string; chipLabels: Record<string, string> }> } | null },
): AgentRevision => ({
  id: `revision-${randomUUID()}`,
  snapshot: {
    customInstruction: null,
    directives: [],
    routines: [],
    contextVariableEnablements: [],
    greeting,
  },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(),
  publishedAt: new Date(),
  publishedVersion: 1,
});

const exactGreetingWithChips = buildRevision({
  exactWordsEnabled: true,
  exactContent: {
    chips: ["refunds", "shipping"],
    variants: [
      { locale: "en", body: "Hi! Ask me anything.", chipLabels: { refunds: "Refund policy", shipping: "Shipping times" } },
      { locale: "de", body: "Hallo!", chipLabels: { refunds: "Rückerstattung", shipping: "Versandzeiten" } },
    ],
  },
});

const createResolver = (revision: AgentRevision | null) => ({
  resolveNew: vi.fn(async () => {
    if (!revision) {
      throw notFound("Agent is not published");
    }
    return {
      revisionId: revision.id,
      revision,
      contextVariableEnablements: revision.snapshot.contextVariableEnablements,
      agent: {} as never,
    };
  }),
  resolvePinned: vi.fn(async () => {
    throw new Error("starter prompts never pin a revision");
  }),
});

const setUp = async (options: { revision: AgentRevision | null; assistantDefaultLocale?: string; proactiveGreetingEnabled?: boolean }) => {
  const workspaceRepository = new InMemoryWorkspaceRepository();
  const workspace = await workspaceRepository.create("account-1", "Workspace");
  await workspaceRepository.updateAssistantBootstrapSettings(workspace.id, {
    assistantName: "Marta",
    greetingInstruction: "",
    assistantDefaultLocale: options.assistantDefaultLocale ?? "en",
    proactiveGreetingEnabled: options.proactiveGreetingEnabled ?? true,
  });
  const agentService = new AgentService(new InMemoryAgentRepository(), workspaceRepository);
  const agent = await agentService.resolve(workspace.id);
  const resolver = createResolver(options.revision);
  const reader = new RevisionGreetingStarterPromptReader(agentService, resolver);
  return { reader, resolver, workspaceId: workspace.id, agentId: agent.id };
};

describe("RevisionGreetingStarterPromptReader", () => {
  it("returns the published exact greeting's chips in the agent's default locale", async () => {
    const { reader, resolver, workspaceId, agentId } = await setUp({ revision: exactGreetingWithChips, assistantDefaultLocale: "de" });

    const prompts = await reader.listStarterPrompts({ workspaceId, agentId });

    expect(prompts).toEqual([{ label: "Rückerstattung" }, { label: "Versandzeiten" }]);
    expect(resolver.resolveNew).toHaveBeenCalledTimes(1);
    expect(resolver.resolvePinned).not.toHaveBeenCalled();
  });

  it("returns nothing for an automatic greeting, an exact greeting without chips, or an unpublished agent", async () => {
    const automatic = await setUp({ revision: buildRevision({ exactWordsEnabled: false, exactContent: null }) });
    expect(await automatic.reader.listStarterPrompts({ workspaceId: automatic.workspaceId, agentId: automatic.agentId })).toEqual([]);

    const noChips = await setUp({
      revision: buildRevision({
        exactWordsEnabled: true,
        exactContent: { chips: [], variants: [{ locale: "en", body: "Hi!", chipLabels: {} }] },
      }),
    });
    expect(await noChips.reader.listStarterPrompts({ workspaceId: noChips.workspaceId, agentId: noChips.agentId })).toEqual([]);

    const unpublished = await setUp({ revision: null });
    expect(await unpublished.reader.listStarterPrompts({ workspaceId: unpublished.workspaceId, agentId: unpublished.agentId })).toEqual([]);
  });

  it("returns nothing when the exact greeting has no variant for the agent's default locale", async () => {
    const { reader, workspaceId, agentId } = await setUp({ revision: exactGreetingWithChips, assistantDefaultLocale: "fr" });

    expect(await reader.listStarterPrompts({ workspaceId, agentId })).toEqual([]);
  });

  it("returns nothing when the agent's greeting is switched off, matching what the web embed shows", async () => {
    const { reader, resolver, workspaceId, agentId } = await setUp({ revision: exactGreetingWithChips, proactiveGreetingEnabled: false });

    expect(await reader.listStarterPrompts({ workspaceId, agentId })).toEqual([]);
    expect(resolver.resolveNew).not.toHaveBeenCalled();
  });
});
