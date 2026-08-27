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
        id: "skill-1",
        name: "notify_ops",
        capability: "notify",
        invocationMode: "routine_named",
        enabled: true,
        target: { kind: "webhook_destination", id: "target-1", label: "Ops webhook", status: "active" },
        configKeys: ["boundPayload", "delivery"],
        settings: {},
      },
    ]);
    expect(result.capabilities).toEqual([
      {
        id: "notify", targetKind: "webhook_destination", requiresTarget: true, targetCount: 1, available: true, unavailableReason: null,
        settingsFields: [
          { key: "delivery.recipientEmails", label: "Recipient emails", type: "string_list" },
          { key: "delivery.webhook.url", label: "Webhook URL", type: "text" },
        ],
      },
      { id: "mcp_tool", targetKind: "mcp_connection", requiresTarget: true, targetCount: 0, available: false, unavailableReason: "no_connection", settingsFields: [] },
      {
        id: "retrieve", targetKind: "workspace", requiresTarget: false, targetCount: 0, available: true, unavailableReason: null,
        settingsFields: [{ key: "vectorTopK", label: "Vector top K", type: "number", defaultValue: 20 }],
      },
    ]);
  });

  it("emits skill config key names only, never config values", async () => {
    const descriptors = buildDescriptors();
    const serialized = JSON.stringify(await descriptors[1].createTool(context).invoke({}, {} as never));

    expect(serialized).toContain("boundPayload");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("shhh-secret");
  });

  it("exposes a value only for a config key the capability declares as a settings field", async () => {
    // notify_ops's config carries delivery.token, which is not a declared settingsField (only
    // delivery.recipientEmails and delivery.webhook.url are). That undeclared value must never
    // leak into `settings`, even though the reader now surfaces declared values.
    const skills = agentSkillPorts();
    skills.list.mockResolvedValueOnce([
      {
        id: "skill-2",
        name: "notify_ops",
        capability: "notify",
        target: { kind: "webhook_destination", id: "target-1" },
        config: { delivery: { recipientEmails: ["ops@example.com"], token: "shhh-secret" } },
        invocationMode: "routine_named",
        enabled: true,
      },
    ]);
    const descriptors = buildDescriptors(documentStatusPorts(), skills);

    const result = await descriptors[1].createTool(context).invoke({}, {} as never) as { skills: Array<{ settings: Record<string, unknown> }> };

    expect(result.skills[0]?.settings).toEqual({ "delivery.recipientEmails": ["ops@example.com"] });
    expect(JSON.stringify(result)).not.toContain("shhh-secret");
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
