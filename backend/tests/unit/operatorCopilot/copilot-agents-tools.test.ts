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
      schemaVersion: 4,
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
    const selectedDirective = directives[40];
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

  // #1352: prepare_agent_settings replaces customInstruction (and branding.privacyPolicyUrl)
  // whole, so a read tool that silently cut either one left an operator unable to safely
  // resubmit it. Both fields are write-bounded above the generic 500-character compaction cap
  // (2,000 and 2,048 respectively), so agent_configuration exempts exactly those two paths.
  describe("full-text authored fields (#1352)", () => {
    it.each([1_231, 2_000])("returns customInstruction in full at %i characters, with no truncation", async (length) => {
      // A phrase-based fixture, padded with a non-whitespace filler tail so the write path's
      // trim() never changes its length regardless of where the target length lands mid-phrase.
      const customInstruction = "Reception contact block. ".repeat(80).slice(0, length).trimEnd().padEnd(length, "x");
      const ports = dependencies(undefined, resolvedAgent(undefined, { customInstruction }));
      const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

      const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as {
        agent: Record<string, unknown>;
      };

      expect(result.agent.customInstruction).toBe(customInstruction);
      expect(result.agent.truncation).toBeUndefined();
    });

    it("returns branding.privacyPolicyUrl in full up to its write-time cap, with no truncation", async () => {
      const longUrl = `https://example.com/${"a".repeat(2_028)}`;
      const ports = dependencies(undefined, resolvedAgent(undefined, { branding: { privacyPolicyUrl: longUrl } }));
      const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

      const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as {
        agent: { branding: { privacyPolicyUrl: string } };
      };

      expect(result.agent.branding.privacyPolicyUrl).toBe(longUrl);
      expect((result.agent as Record<string, unknown>).truncation).toBeUndefined();
    });

    it("keeps the whole agent detail response bounded when both exempt fields sit at their write-time caps", async () => {
      const customInstruction = "x".repeat(2_000);
      const longUrl = `https://example.com/${"a".repeat(2_028)}`;
      const ports = dependencies(undefined, resolvedAgent(undefined, {
        customInstruction,
        branding: { privacyPolicyUrl: longUrl },
      }));
      const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

      const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as {
        agent: Record<string, unknown>;
      };

      expect(result.agent.customInstruction).toBe(customInstruction);
      expect((result.agent.branding as { privacyPolicyUrl: string }).privacyPolicyUrl).toBe(longUrl);
      expect(result.agent.truncation).toBeUndefined();
      // Worst case for the two exempt fields adds at most (2,000 - 500) + (2,048 - 500) = 3,048
      // characters over the generic 500-char-per-string cap this tool otherwise applies —
      // negligible next to the built-in and selected-directive detail budgets already carried
      // separately (20,000 + 24,000 characters), and far under the turn runtime's single-result
      // ceiling (24,000 tokens, ~96,000 characters at 4 chars/token).
      expect(JSON.stringify(result).length).toBeLessThan(20_000);
    });

    it("still compacts a genuinely unbounded authored field (no write-time cap to exempt against)", async () => {
      const oversizedFilename = `${"f".repeat(3_000)}.png`;
      const ports = dependencies(undefined, resolvedAgent(undefined, {
        logo: { bucket: "b", objectPath: "o", generation: null, mimeType: "image/png", filename: oversizedFilename, sizeBytes: 10 },
      }));
      const tool = ports.descriptors.find((descriptor) => descriptor.name === "agent_configuration")!;

      const result = await tool.createTool(context("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).invoke({}, {} as never) as {
        agent: { logo: { filename: string }; truncation?: { entries: Array<{ path: string; reason: string }> } };
      };

      expect(result.agent.logo.filename.length).toBe(501);
      expect(result.agent.truncation?.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "$.logo.filename", reason: "string_length" }),
      ]));
    });
  });
});
