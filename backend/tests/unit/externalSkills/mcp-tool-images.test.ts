import { describe, expect, it, vi } from "vitest";

import { McpSkillExecutor, type McpSkillExecutorDeps } from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import type { McpToolImageSink } from "../../../src/modules/externalSkills/toolService/mcpToolImages.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import { createToolSkillExecutor } from "@radioso/conversation-tools";
import { connectMockMcpServer, type MockToolResult } from "../../support/mockMcpServer.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const service = (result: MockToolResult, images?: McpToolImageSink) => new SdkMcpToolService({
  transportFactory: async () => (await connectMockMcpServer([{ name: "floor_plan", respond: () => result }])).clientTransport,
  ...(images ? { images } : {}),
});

const sink = () => {
  let next = 0;
  const kept: Buffer[] = [];
  const dropped: string[] = [];
  const images: McpToolImageSink = {
    keep: vi.fn(async (bytes: Buffer) => {
      kept.push(bytes);
      return { kept: true as const, imageId: `image-${++next}` };
    }),
    dropped: (reason) => dropped.push(reason),
  };
  return { images, kept, dropped };
};

const image = (bytes: Buffer, mimeType = "image/png") => ({ type: "image", data: bytes.toString("base64"), mimeType });

describe("MCP tool images", () => {
  it("keeps an image block's bytes and puts only its id on the outcome", async () => {
    const { images, kept } = sink();

    const outcome = await service({ content: [{ type: "text", text: "The floor plan." }, image(PNG)] }, images).callTool({ toolName: "floor_plan" });

    expect(kept).toEqual([PNG]);
    expect(outcome).toMatchObject({ status: "completed", answer: "The floor plan.", media: [{ kind: "image", imageId: "image-1" }] });
    expect(JSON.stringify(outcome)).not.toContain(PNG.toString("base64"));
  });

  it("drops an SVG, a block past the size cap, and any past four", async () => {
    const { images, kept, dropped } = sink();
    const huge = Buffer.alloc(5 * 1024 * 1024 + 10);

    const outcome = await service({
      content: [
        image(Buffer.from("<svg/>"), "image/svg+xml"),
        image(huge),
        ...Array.from({ length: 5 }, () => image(PNG)),
      ],
    }, images).callTool({ toolName: "floor_plan" });

    expect(kept).toHaveLength(4);
    expect(dropped).toEqual(["unsupported_type", "too_large", "over_limit"]);
    expect(outcome.media).toHaveLength(4);
  });

  it("ignores image blocks when no sink is given", async () => {
    const outcome = await service({ content: [image(PNG)], structuredContent: { ok: true } }).callTool({ toolName: "floor_plan" });

    expect(outcome).not.toHaveProperty("media");
  });

  it("keeps a call's images for the stored conversation that made it, and none for a replay", async () => {
    const accept = vi.fn(async () => ({ kept: true as const, imageId: "kept-1" }));
    const metrics = { incrementCounter: vi.fn() };
    const deps: McpSkillExecutorDeps = {
      skills: { findEnabledByName: async () => ({ id: "s", agentId: "agent-1", workspaceId: "ws-1", skillName: "floor_plan", connectionId: "c", toolName: "floor_plan", boundParams: {}, exposedParams: [], enabled: true }) as never },
      connections: { findById: async () => ({ id: "c", serverUrl: "https://mcp.example/", authMethod: "access_token" }) },
      toolServices: {
        create: (_connection, call) => service({ content: [image(PNG)], structuredContent: { ok: true } }, call?.images),
      },
      toolSkillExecutorFactory: createToolSkillExecutor,
      imageIntake: { accept },
      metrics,
    };
    const dispatch = (context: Record<string, unknown>) => new McpSkillExecutor(deps).dispatch({
      skill: { name: "floor_plan" },
      collected: {},
      context: { agentId: "agent-1", workspaceId: "ws-1", conversationId: "conv-1", ...context },
      emit: { emit: () => undefined } as never,
    });

    const durable = await dispatch({ conversationDurability: "durable" });
    const replay = await dispatch({ conversationDurability: "ephemeral" });

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({ workspaceId: "ws-1", conversationId: "conv-1", bytes: PNG });
    expect(durable).toMatchObject({ disposition: "settled", outcome: { media: [{ kind: "image", imageId: "kept-1" }] } });
    expect(replay).toMatchObject({ disposition: "settled", outcome: { status: "completed" } });
    expect(replay.disposition === "settled" ? replay.outcome.media : undefined).toBeUndefined();
    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_intake_dropped_total", expect.objectContaining({ labels: { reason: "no_conversation" } }));
  });
});
