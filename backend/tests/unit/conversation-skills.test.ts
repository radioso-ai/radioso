import { describe, expect, it, vi } from "vitest";

import { ConversationSkills } from "../../src/modules/agentSkills/conversationSkills.js";
import type { AgentSkillSpine } from "../../src/modules/agentSkills/public.js";
import { withConversationSkills } from "../../src/shared/domain/conversationSkills.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const skill = (overrides: Partial<AgentSkillSpine> = {}): AgentSkillSpine => ({
  id: "33333333-3333-4333-8333-333333333333",
  agentId,
  workspaceId,
  skillName: "lookup_orders",
  kind: "webhook",
  invocationMode: "routine_named",
  enabled: true,
  targetType: "webhook_destination",
  targetId: "44444444-4444-4444-8444-444444444444",
  config: { boundPayload: { source: "release" } },
  createdAt: new Date("2026-11-01T09:00:00.000Z"),
  updatedAt: new Date("2026-11-01T09:00:00.000Z"),
  ...overrides,
});

const build = (input: { live?: AgentSkillSpine[]; release?: { agentSkills?: AgentSkillSpine[] } | null } = {}) => {
  const fallbacks: string[] = [];
  const live = { listByAgent: vi.fn(async () => input.live ?? []) };
  const skills = new ConversationSkills({
    live,
    releases: { findConversationRelease: vi.fn(async () => input.release ?? null) },
    onLiveFallback: (reason) => fallbacks.push(reason),
  });
  return { skills, live, fallbacks };
};

describe("ConversationSkills", () => {
  it("gives a turn the skills its release froze, without reading the live table", async () => {
    const { skills, live, fallbacks } = build({ live: [skill({ enabled: false })] });

    await expect(skills.forTurn({ workspaceId, id: agentId, authoredAgentSkills: [skill()] }))
      .resolves.toEqual([skill()]);
    expect(live.listByAgent).not.toHaveBeenCalled();
    expect(fallbacks).toEqual([]);
  });

  it("reads the live table for a turn whose release recorded no skills, and counts it", async () => {
    const { skills, fallbacks } = build({ live: [skill({ enabled: false })] });

    await expect(skills.forTurn({ workspaceId, id: agentId })).resolves.toEqual([skill({ enabled: false })]);
    expect(fallbacks).toEqual(["release_unrecorded"]);
  });

  it("gives queued work the skills of the release its conversation is pinned to", async () => {
    const { skills, fallbacks } = build({ live: [skill({ enabled: false })], release: { agentSkills: [skill()] } });

    await expect(skills.forConversation({ workspaceId, agentId, conversationId: "c-1" })).resolves.toEqual([skill()]);
    expect(fallbacks).toEqual([]);
  });

  it("falls back to the live table for queued work whose conversation is pinned to no release", async () => {
    const { skills, fallbacks } = build({ live: [skill({ enabled: false })], release: null });

    await expect(skills.forConversation({ workspaceId, agentId, conversationId: "c-1" })).resolves.toEqual([skill({ enabled: false })]);
    expect(fallbacks).toEqual(["conversation_unpinned"]);
  });

  it("looks a skill up in the conversation's set an invocation carries, not the live row", async () => {
    const { skills, fallbacks } = build();
    const live = vi.fn(async (): Promise<Record<string, unknown> | undefined> => ({ source: "live" }));
    const lookup = skills.scopedLookup({ kind: "webhook", fromSkill: (found) => found.config, live });

    await expect(lookup({ workspaceId, agentId, skillName: "lookup_orders", context: withConversationSkills([skill()]) }))
      .resolves.toEqual({ boundPayload: { source: "release" } });
    await expect(lookup({ workspaceId, agentId, skillName: "lookup_orders", context: withConversationSkills([skill({ enabled: false })]) }))
      .resolves.toBeNull();
    await expect(lookup({ workspaceId, agentId, skillName: "lookup_orders", context: withConversationSkills([skill({ kind: "notify" })]) }))
      .resolves.toBeNull();
    expect(live).not.toHaveBeenCalled();
    expect(fallbacks).toEqual([]);
  });

  it("uses the live lookup for an invocation that carries no conversation skills, and counts it", async () => {
    const { skills, fallbacks } = build();
    const lookup = skills.scopedLookup({ kind: "webhook", fromSkill: () => "release row", live: async () => "live row" });

    await expect(lookup({ workspaceId, agentId, skillName: "lookup_orders", context: { agentId } })).resolves.toBe("live row");
    expect(fallbacks).toEqual(["not_threaded"]);
  });
});
