import { describe, expect, it } from "vitest";

import { agentSkillPorts, buildDescriptors, documentSkillsContext as context, documentStatusPorts } from "./copilot-tools-test-helpers.js";

describe("copilot agent skills readers", () => {
  it("joins configured skills to their capability targets and reports capability availability", async () => {
    const skills = agentSkillPorts();
    const descriptors = buildDescriptors(documentStatusPorts(), skills);

    const result = await descriptors[1].createTool(context).invoke({}, {} as never) as {
      skills: Array<Record<string, unknown>>;
      capabilities: Array<Record<string, unknown>>;
    };

    expect(skills.get).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(skills.list).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(result.skills).toEqual([
      {
        name: "notify_ops",
        capability: "notify",
        invocationMode: "routine_named",
        enabled: true,
        target: { kind: "webhook_destination", id: "target-1", label: "Ops webhook", status: "active" },
        configKeys: ["boundPayload", "delivery"],
      },
    ]);
    expect(result.capabilities).toEqual([
      { id: "notify", targetKind: "webhook_destination", requiresTarget: true, targetCount: 1, available: true, unavailableReason: null },
      { id: "mcp_tool", targetKind: "mcp_connection", requiresTarget: true, targetCount: 0, available: false, unavailableReason: "no_connection" },
      { id: "retrieve", targetKind: "workspace", requiresTarget: false, targetCount: 0, available: true, unavailableReason: null },
    ]);
  });

  it("emits skill config key names only, never config values", async () => {
    const descriptors = buildDescriptors();
    const serialized = JSON.stringify(await descriptors[1].createTool(context).invoke({}, {} as never));

    expect(serialized).toContain("boundPayload");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("shhh-secret");
  });

  it("proves the agent belongs to the workspace before enumerating agent-scoped targets", async () => {
    const skills = agentSkillPorts();
    skills.get.mockRejectedValueOnce(new Error("Agent not found"));
    const descriptors = buildDescriptors(documentStatusPorts(), skills);

    await expect(descriptors[1].createTool(context).invoke({ agentId: "agent-9" }, {} as never)).rejects.toThrow("Agent not found");

    expect(skills.get).toHaveBeenCalledWith("workspace-1", "agent-9");
    expect(skills.list).not.toHaveBeenCalled();
    for (const descriptor of skills.registryList.mock.results.flatMap((entry) => entry.value ?? [])) {
      expect(descriptor.enumerateTargets).not.toHaveBeenCalled();
    }
  });

  it("falls back to the page context agent and links the agent entity", async () => {
    const skills = agentSkillPorts();
    const descriptors = buildDescriptors(documentStatusPorts(), skills);

    await descriptors[1].createTool(context).invoke({}, {} as never);

    expect(skills.list).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(descriptors[1].describeEntity?.({}, context)).toEqual({ type: "agent", id: "agent-1" });
    expect(descriptors[1].describeEntity?.({ agentId: "agent-7" }, context)).toEqual({ type: "agent", id: "agent-7" });
  });
});
