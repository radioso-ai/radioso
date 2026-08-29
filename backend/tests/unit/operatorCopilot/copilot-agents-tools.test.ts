import { describe, expect, it } from "vitest";

import { builtInAnswerDirectiveViews } from "../../../src/modules/directives/public.js";
import { authoredDirective, context, dependencies, resolvedAgent } from "./copilot-tools-test-helpers.js";

describe("copilot agent readers", () => {
  it("lists bounded safe agent summaries without creating or resolving an agent", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context(null)).invoke({ mode: "list" }, {} as never);

    expect(ports.listAgents).toHaveBeenCalledWith("workspace-1");
    expect(ports.resolveAgent).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "list",
      agentCount: 1,
      agentsTruncated: false,
      agents: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Support", isDefault: true, assistantBootstrapActive: false }],
      agent: null,
    });
    expect(JSON.stringify(result)).not.toContain("must not leak");
    expect(tool.describeEntity?.({}, context(null))).toBeNull();
  });

  it("allows explicit discovery even when page context selects an agent", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ mode: "list" }, {} as never);

    expect(result).toMatchObject({ mode: "list", agentCount: 1, agent: null });
    expect(ports.listAgents).toHaveBeenCalledOnce();
    expect(ports.resolveAgent).not.toHaveBeenCalled();
    expect(tool.describeEntity?.({ mode: "list" }, context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))).toBeNull();
  });

  it("bounds agent discovery with explicit counts and truncation metadata", async () => {
    const ports = dependencies();
    ports.listAgents.mockResolvedValue(Array.from({ length: 41 }, (_, index) => ({
      id: `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      name: `Agent ${index}`,
      isDefault: index === 0,
      assistantBootstrapActive: false,
    })) as never);
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context(null)).invoke({ mode: "list" }, {} as never) as { agents: unknown[]; agentCount: number; agentsTruncated: boolean };

    expect(result.agents).toHaveLength(40);
    expect(result.agentCount).toBe(41);
    expect(result.agentsTruncated).toBe(true);
  });

  it("returns only the selected agent with redacted config and directive identities", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as {
      agent: Record<string, unknown>;
    };
    const serialized = JSON.stringify(result);

    expect(ports.resolveAgent).toHaveBeenCalledWith("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(ports.listAgents).not.toHaveBeenCalled();
    expect(result.agent).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      schemaVersion: 3,
      directiveCount: 1,
      directivesTruncated: false,
      directiveRefs: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Do not guess" }],
      directive: null,
      builtInDirectiveCount: builtInAnswerDirectiveViews.length,
      builtInsTruncated: false,
      builtIns: builtInAnswerDirectiveViews.map((directive) => ({
        ...directive,
        actionChars: directive.action.length,
        omittedReason: null,
      })),
      surfaceSettings: {
        anonymousChat: { token: { __redacted: "secret" } },
        websiteEmbed: {
          token: { __redacted: "secret" },
          allowedOrigins: [{ __ref: "websiteEmbedAllowedOrigin" }],
        },
      },
    });
    expect(serialized).not.toContain("raw-anonymous-token");
    expect(serialized).not.toContain("raw-embed-token");
    expect(serialized).not.toContain("https://private.example.com");
  });

  it("reports whether a directive is enabled, in both the summary list and the detail view", async () => {
    const directives = [
      authoredDirective({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Live directive",
        enabled: true,
      }),
      authoredDirective({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        name: "Disabled directive",
        enabled: false,
      }),
    ];
    const ports = dependencies(undefined, resolvedAgent(directives));
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({
      mode: "detail",
      directiveId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }, {} as never) as { agent: Record<string, unknown> };

    expect(result.agent.authoredDirectives).toEqual([
      expect.objectContaining({ name: "Live directive", enabled: true }),
      expect.objectContaining({ name: "Disabled directive", enabled: false }),
    ]);
    expect(result.agent.directive).toMatchObject({ name: "Disabled directive", enabled: false });
  });

  it("reports directive bounds and retrieves a selected long directive without truncating its action", async () => {
    const longAction = "Evidence ".repeat(440).trim();
    const directives = Array.from({ length: 41 }, (_, index) => authoredDirective({
      id: `${String(index).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      name: `Directive ${index}`,
      action: index === 40 ? longAction : `Action ${index}`,
      requiredCapabilities: index === 40
        ? Array.from({ length: 11 }, (_, capabilityIndex) => `capability-${capabilityIndex}-${"x".repeat(180)}`)
        : [],
      metadata: index === 40 ? { oversized: "m".repeat(5_000) } : {},
    }));
    const selectedDirective = directives[40]!;
    const ports = dependencies(undefined, resolvedAgent(directives));
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({
      mode: "detail",
      directiveId: selectedDirective.id,
    }, {} as never) as { agent: Record<string, unknown> };

    expect(result).toMatchObject({
      mode: "detail",
      agentCount: null,
      agentsTruncated: null,
      agent: {
        directiveCount: 41,
        directivesTruncated: true,
        directiveRefs: expect.arrayContaining([{ id: selectedDirective.id, name: "Directive 40" }]),
        directive: {
          id: selectedDirective.id,
          name: "Directive 40",
          action: longAction,
          requiredCapabilities: expect.any(Array),
          metadata: null,
          detailBounds: {
            metadataOmittedReason: "content_too_large",
            truncatedCollections: ["requiredCapabilities"],
          },
        },
      },
    });
    expect((result.agent.directiveRefs as unknown[])).toHaveLength(40);
    expect(((result.agent.directive as { requiredCapabilities: unknown[] }).requiredCapabilities)).toHaveLength(10);
    expect(JSON.stringify(result)).toContain(longAction);
    expect(JSON.stringify(result)).not.toContain("mmm");
  });

  it("prefers an explicit agent id over page context", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

    await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({ agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, {} as never);

    expect(ports.resolveAgent).toHaveBeenCalledWith("workspace-1", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });
});
