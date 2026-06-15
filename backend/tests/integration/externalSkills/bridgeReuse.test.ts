import { describe, expect, it } from "vitest";

import { createToolSkillExecutor } from "@radioso/conversation-tools";
import type { SkillDefinition } from "@radioso/conversation-contract";

import { connectMockMcpServer } from "../../support/mockMcpServer.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";

/**
 * Keystone: the transport-agnostic `ToolSkillBridge` (used UNCHANGED from
 * `@radioso/conversation-tools`) turns our SDK-backed `ToolService` into a skill
 * executor that returns a settled `SkillOutcome`. This is the seam the routine
 * runner branches on — proving MCP plugs into the existing skill port without any
 * engine/contract change.
 */
const skillFor = (toolName: string): SkillDefinition => ({
  name: toolName,
  metadata: { conversationTool: { toolName } },
});

const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

describe("ToolSkillBridge reuse with SdkMcpToolService", () => {
  it("dispatches an MCP tool through the unchanged bridge to a settled completed outcome", async () => {
    const { clientTransport } = await connectMockMcpServer([
      {
        name: "post_message",
        respond: (args) => ({
          content: [{ type: "text", text: "posted" }],
          structuredContent: { ok: true, echoed: args },
        }),
      },
    ]);
    const service = new SdkMcpToolService({ transportFactory: () => clientTransport });
    const executor = createToolSkillExecutor(service);

    const dispatched = await executor.dispatch({
      skill: skillFor("post_message"),
      collected: { channel: "#support", message: "hi" },
      emit: noopEmit,
    });

    expect(dispatched.disposition).toBe("settled");
    if (dispatched.disposition === "settled") {
      expect(dispatched.outcome.status).toBe("completed");
      expect(dispatched.outcome.outputs).toMatchObject({ ok: true, echoed: { channel: "#support", message: "hi" } });
    }
    await service.close();
  });

  it("maps an MCP tool error to a settled failed outcome through the bridge", async () => {
    const { clientTransport } = await connectMockMcpServer([
      { name: "book", respond: () => ({ content: [{ type: "text", text: "slot taken" }], isError: true }) },
    ]);
    const service = new SdkMcpToolService({ transportFactory: () => clientTransport });
    const executor = createToolSkillExecutor(service);

    const dispatched = await executor.dispatch({
      skill: skillFor("book"),
      collected: {},
      emit: noopEmit,
    });

    expect(dispatched.disposition).toBe("settled");
    if (dispatched.disposition === "settled") {
      expect(dispatched.outcome.status).toBe("failed");
    }
    await service.close();
  });
});
