import { describe, expect, it } from "vitest";

import { AgentService } from "../../src/modules/agents/services/agentService.js";
import { InMemoryAccessGrantRepository } from "../support/fakes.js";
import { DefaultOriginMatcher } from "../../src/modules/accessGrants/originMatcher.js";
import { AccessGrantService } from "../../src/modules/accessGrants/services/accessGrantService.js";

describe("AgentService public launch origin constraints", () => {
  it("syncs website embed settings to a list origin constraint by default", async () => {
    const { service, accessGrantService } = createService();

    const agent = await service.create("workspace-1", {
      surfaceSettings: {
        websiteEmbed: {
          enabled: true,
          token: "embed-token-list",
          allowedOrigins: ["https://a.example"],
        },
      },
    });

    const grant = await accessGrantService.resolvePublicLaunchGrant(agent.surfaceSettings.websiteEmbed.token!);
    expect(grant?.originConstraint).toEqual({ mode: "list", origins: ["https://a.example"] });
  });

  it('syncs ["*"] website embed settings to an allow-all origin constraint', async () => {
    const { service, accessGrantService } = createService();

    const agent = await service.create("workspace-1", {
      surfaceSettings: {
        websiteEmbed: {
          enabled: true,
          token: "embed-token-allow-all",
          allowedOrigins: ["*"],
        },
      },
    });

    const grant = await accessGrantService.resolvePublicLaunchGrant(agent.surfaceSettings.websiteEmbed.token!);
    expect(grant?.originConstraint).toEqual({ mode: "allow-all", origins: [] });
  });

  it("resolves contact affordance state from contact_human notify skill with legacy fallback", async () => {
    const legacy = createService();
    const legacyAgent = await legacy.service.create("workspace-1", {
      contactRequestsEnabled: true,
    });
    await expect(legacy.service.resolve("workspace-1", legacyAgent.id))
      .resolves.toMatchObject({ contactRequestsEnabled: true });

    const skillBacked = createService({
      findByName: async () => ({
        id: "skill-1",
        workspaceId: "workspace-1",
        agentId: legacyAgent.id,
        skillName: "contact_human",
        kind: "notify",
        targetType: "notify_delivery",
        targetId: null,
        config: {},
        invocationMode: "routine_named",
        enabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    const skillBackedAgent = await skillBacked.service.create("workspace-1", {
      contactRequestsEnabled: true,
    });

    await expect(skillBacked.service.resolve("workspace-1", skillBackedAgent.id))
      .resolves.toMatchObject({ contactRequestsEnabled: false });
  });

  it("folds the enabled notify skill's delivery into contactRequestDelivery so the contact gate matches dispatch", async () => {
    const harness = createService({
      findByName: async () => ({
        id: "skill-1",
        workspaceId: "workspace-1",
        agentId: "agent",
        skillName: "contact_human",
        kind: "notify",
        targetType: "notify_delivery",
        targetId: null,
        config: { delivery: { recipientEmails: ["notify@example.com"], webhook: null } },
        invocationMode: "routine_named",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    // Legacy contactRequestDelivery is empty — only the notify skill has a destination.
    const agent = await harness.service.create("workspace-1", { contactRequestsEnabled: true });

    const resolved = await harness.service.resolve("workspace-1", agent.id);
    expect(resolved.contactRequestsEnabled).toBe(true);
    expect(resolved.contactRequestDelivery.recipientEmails).toEqual(["notify@example.com"]);
  });
});

const createService = (agentSkills?: ConstructorParameters<typeof AgentService>[5]) => {
  const accessGrantService = new AccessGrantService({
    repository: new InMemoryAccessGrantRepository(),
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: "fedcba9876543210fedcba9876543210",
  });
  const agentRepository = new InMemoryAgentRepository();
  const service = new AgentService(
    agentRepository,
    {
      async findById(id: string) {
        return id === "workspace-1"
          ? {
              id,
              accountId: "account-1",
              name: "Workspace",
              createdAt: new Date(),
              updatedAt: new Date(),
              publicRouteKey: "workspace",
              defaultAgentId: null,
              assistantName: "",
              greetingInstruction: "",
              assistantDefaultLocale: null,
              proactiveGreetingEnabled: false,
              anonymousChatEnabled: false,
              anonymousChatToken: null,
              anonymousRateLimit: 10,
              websiteEmbedEnabled: false,
              websiteEmbedToken: null,
              websiteEmbedAllowedOrigins: [],
              websiteEmbedLauncherLabel: "Chat with us",
              websiteEmbedLauncherPosition: "bottom-right" as const,
              websiteEmbedTheme: {
                brand: "#0f172a",
                brandText: "#f8fafc",
                surface: "#ffffff",
                text: "#0f172a",
              },
              websiteEmbedCopy: {},
              websiteEmbedExpertOverrides: {},
            }
          : null;
      },
      async updateGeneralSettings() {
        throw new Error("not used");
      },
    },
    undefined,
    undefined,
    accessGrantService,
    agentSkills,
  );
  return { service, accessGrantService };
};

type AgentRecord = Awaited<ReturnType<AgentService["resolve"]>>;

class InMemoryAgentRepository {
  private agents: AgentRecord[] = [];

  async create(workspaceId: string, input: Parameters<AgentService["create"]>[1]): Promise<AgentRecord> {
    const { validateAgentInput } = await import("../../src/modules/agents/domain.js");
    const normalized = validateAgentInput(input);
    const now = new Date();
    const agent = {
      id: `agent-${this.agents.length + 1}`,
      workspaceId,
      createdAt: now,
      updatedAt: now,
      ...normalized,
    };
    this.agents.push(agent);
    return agent;
  }

  async update(agentId: string, workspaceId: string, input: Parameters<AgentService["update"]>[2]): Promise<AgentRecord> {
    const existing = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!existing) throw new Error("not found");
    const { validateAgentInput, mergeAgentSurfaceSettings } = await import("../../src/modules/agents/domain.js");
    const normalized = validateAgentInput({
      ...existing,
      ...input,
      surfaceSettings: mergeAgentSurfaceSettings(existing.surfaceSettings, input.surfaceSettings),
    });
    const updated = { ...existing, ...normalized, updatedAt: new Date() };
    this.agents = this.agents.map((agent) => agent.id === agentId ? updated : agent);
    return updated;
  }

  async listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    return this.agents.filter((agent) => agent.workspaceId === workspaceId);
  }

  async findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null> {
    return this.agents.find((agent) => agent.workspaceId === workspaceId) ?? null;
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    return this.agents.find((agent) => agent.id === agentId && agent.workspaceId === workspaceId) ?? null;
  }

  async findByAnonymousChatToken(token: string): Promise<AgentRecord | null> {
    return this.agents.find((agent) => agent.surfaceSettings.anonymousChat.token === token) ?? null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null> {
    return this.agents.find((agent) => agent.surfaceSettings.websiteEmbed.token === token) ?? null;
  }

  async setDefault(): Promise<void> {}
  async countByWorkspaceId(): Promise<number> { return this.agents.length; }
  async deleteByIdAndWorkspaceId(): Promise<boolean> { return false; }
  async listDirectives(): Promise<[]> { return []; }
  async createDirective(): Promise<never> { throw new Error("not used"); }
  async updateDirective(): Promise<never> { throw new Error("not used"); }
  async deleteDirective(): Promise<boolean> { return false; }
}
