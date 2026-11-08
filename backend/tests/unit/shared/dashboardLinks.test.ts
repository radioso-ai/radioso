import { describe, expect, it } from "vitest";

import { agentSkillsPermalink, conversationPermalink } from "../../../src/shared/domain/dashboardLinks.js";

describe("conversationPermalink", () => {
  it("addresses a conversation through the workspace activity route", () => {
    const url = new URL(conversationPermalink(
      { workspacePublicRouteKey: "support-abc123", conversationId: "conv_1" },
      "https://app.radioso.ai",
    ));

    expect(url.origin).toBe("https://app.radioso.ai");
    expect(url.pathname).toBe("/w/support-abc123/activity");
    expect(url.searchParams.get("itemKind")).toBe("chat");
    expect(url.searchParams.get("itemId")).toBe("conv_1");
  });

  it("names the lens explicitly so the runtime default cannot redirect the operator away", () => {
    const url = new URL(conversationPermalink(
      { workspacePublicRouteKey: "support-abc123", conversationId: "conv_1" },
      "https://app.radioso.ai",
    ));

    expect(url.searchParams.get("tab")).toBe("all");
    expect(url.searchParams.get("filter")).toBe("chat");
  });

  it("falls back to the local development origin when no base URL is configured", () => {
    expect(conversationPermalink(
      { workspacePublicRouteKey: "support-abc123", conversationId: "conv_1" },
      undefined,
    )).toContain("http://localhost:3000/w/support-abc123/activity");
  });

  it("escapes a workspace key so it cannot alter the path", () => {
    const url = new URL(conversationPermalink(
      { workspacePublicRouteKey: "a/../../evil", conversationId: "conv_1" },
      "https://app.radioso.ai",
    ));

    expect(url.pathname).toBe("/w/a%2F..%2F..%2Fevil/activity");
  });
});

describe("agentSkillsPermalink", () => {
  it("opens the agent's behavior page at its skills", () => {
    const url = new URL(agentSkillsPermalink(
      { workspacePublicRouteKey: "support-abc123", agentId: "agent_1" },
      "https://app.radioso.ai",
    ));

    expect(url.origin).toBe("https://app.radioso.ai");
    expect(url.pathname).toBe("/w/support-abc123/agents/agent_1");
    expect(url.searchParams.get("tab")).toBe("behavior");
    expect(url.searchParams.get("anchor")).toBe("assistant-skills");
  });

  it("opens the workspace's agents when the notice named no agent", () => {
    const url = new URL(agentSkillsPermalink({ workspacePublicRouteKey: "support-abc123", agentId: null }, "https://app.radioso.ai"));

    expect(url.pathname).toBe("/w/support-abc123/agents");
    expect(url.search).toBe("");
  });

  it("escapes a key and an agent id so they cannot alter the path", () => {
    const url = new URL(agentSkillsPermalink({ workspacePublicRouteKey: "a/../b", agentId: "x/../y" }, "https://app.radioso.ai"));

    expect(url.pathname).toBe("/w/a%2F..%2Fb/agents/x%2F..%2Fy");
  });
});
