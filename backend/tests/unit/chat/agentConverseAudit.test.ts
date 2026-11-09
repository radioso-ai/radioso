import { describe, expect, it, vi } from "vitest";

import { AgentConverseAudit } from "../../../src/modules/chat/services/agentConverseAudit.js";

const askOutcome = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  grantId: null,
  publicSessionId: "session-1",
  status: "success" as const,
};

describe("AgentConverseAudit.recordAskOutcome", () => {
  it("keeps recording an MCP turn as mcp_converse.ask", async () => {
    const record = vi.fn(async () => {});
    await new AgentConverseAudit({ record }).recordAskOutcome({ ...askOutcome, sourceChannel: "mcp" });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "mcp_converse.ask",
      eventStatus: "success",
      metadata: expect.objectContaining({ sourceChannel: "mcp", agentId: "agent-1", publicSessionId: "session-1" }),
    }));
  });

  it("records an A2A turn under its own event type, so the security feed names the door", async () => {
    const record = vi.fn(async () => {});
    await new AgentConverseAudit({ record }).recordAskOutcome({
      ...askOutcome,
      sourceChannel: "a2a",
      status: "failure",
      reason: "AppError",
    });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "a2a.ask",
      eventStatus: "failure",
      metadata: expect.objectContaining({ sourceChannel: "a2a", reason: "AppError" }),
    }));
  });
});
