import { describe, expect, it, vi } from "vitest";

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

  it("never surfaces a notify skill's webhook URL or recipient emails, only their key names", async () => {
    // The fixture skill's config carries a real webhook URL and recipient email (secret-bearing
    // and PII respectively). Neither notify settingsField opts into `showValueToCopilot`, so both
    // must stay out of the tool output entirely while their key names remain visible via
    // configKeys and the capability's settingsFields metadata.
    const skills = agentSkillPorts();
    const descriptors = buildDescriptors(documentStatusPorts(), skills);

    const result = await descriptors[1].createTool(context).invoke({}, {} as never) as {
      skills: Array<{ configKeys: string[]; settings: Record<string, unknown> }>;
    };
    const serialized = JSON.stringify(result);

    expect(result.skills[0]?.configKeys).toEqual(["boundPayload", "delivery"]);
    expect(result.skills[0]?.settings).toEqual({});
    expect(serialized).not.toContain("ops@example.com");
    expect(serialized).not.toContain("abc123secrettoken");
    expect(serialized).not.toContain("hooks.example.com");
    expect(serialized).toContain("delivery.recipientEmails");
    expect(serialized).toContain("delivery.webhook.url");
  });

  it("exposes a value only for a settings field the capability opts into copilot visibility, never an undeclared key", async () => {
    // notify_ops's config carries delivery.token, which is not a declared settingsField at all
    // (only delivery.recipientEmails and delivery.webhook.url are, and neither opts in). That
    // undeclared value must never leak into `settings`, and neither may the declared-but-hidden
    // ones.
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

    expect(result.skills[0]?.settings).toEqual({});
    expect(JSON.stringify(result)).not.toContain("shhh-secret");
    expect(JSON.stringify(result)).not.toContain("ops@example.com");
  });

  it("hides a settings field's value by default and only surfaces it once a capability opts in with showValueToCopilot", async () => {
    // Two settingsFields on the same skill: one carries no `showValueToCopilot` flag (the
    // deny-by-default case a capability author gets for free), the other explicitly opts in. Only
    // the opted-in field's value may reach `settings` — proving the filter is opt-in, not a
    // blanket hide that would pass this test even if the opt-in check were deleted.
    const skills = agentSkillPorts();
    skills.registryList.mockReturnValueOnce([
      {
        id: "notify",
        targetKind: "webhook_destination",
        requiresTarget: true,
        settingsFields: [
          { key: "delivery.recipientEmails", label: "Recipient emails", type: "string_list" },
          { key: "exposedInputs.message", label: "Expose message", type: "boolean", showValueToCopilot: true },
        ],
        enumerateTargets: vi.fn(async () => [{ id: "target-1", label: "Ops webhook", status: "active" }]),
      },
      { id: "mcp_tool", targetKind: "mcp_connection", requiresTarget: true, settingsFields: [], enumerateTargets: vi.fn(async () => []) },
      { id: "retrieve", targetKind: "workspace", requiresTarget: false, settingsFields: [], enumerateTargets: vi.fn(async () => []) },
    ]);
    skills.list.mockResolvedValueOnce([
      {
        id: "skill-4",
        name: "notify_ops",
        capability: "notify",
        target: { kind: "webhook_destination", id: "target-1" },
        config: { delivery: { recipientEmails: ["ops@example.com"] }, exposedInputs: { message: true } },
        invocationMode: "routine_named",
        enabled: true,
      },
    ]);
    const descriptors = buildDescriptors(documentStatusPorts(), skills);

    const result = await descriptors[1].createTool(context).invoke({}, {} as never) as { skills: Array<{ settings: Record<string, unknown> }> };

    expect(result.skills[0]?.settings).toEqual({ "exposedInputs.message": true });
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
