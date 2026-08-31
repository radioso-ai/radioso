import { describe, expect, it, vi } from "vitest";

import { ProbeConversationReader } from "../../../src/modules/chat/composition.js";
import { ProbeRoutineReader } from "../../../src/modules/routines/public.js";
import { notFound } from "../../../src/shared/domain/errors.js";

describe("operator probe owner ports", () => {
  it("uses the Chat-owned identity port rather than exposing a Copilot repository dependency", async () => {
    const findByIdAndWorkspaceId = vi.fn(async () => ({
      id: "conversation-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      agentName: null,
      agentInternalName: null,
      sourceChannel: "operator_copilot",
      sourceOrigin: "operator:1",
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: new Date("2026-08-30T00:00:00.000Z"),
      updatedAt: new Date("2026-08-30T00:00:00.000Z"),
    }));
    const reader = new ProbeConversationReader({ findByIdAndWorkspaceId });

    await expect(reader.findProbeConversation("conversation-1", "workspace-1")).resolves.toMatchObject({ agentId: "agent-1" });
    expect(findByIdAndWorkspaceId).toHaveBeenCalledWith("conversation-1", "workspace-1");
  });

  it("uses the Routines-owned service and normalizes a missing preview to the probe's closed result", async () => {
    const get = vi.fn(async () => { throw notFound("Routine definition not found"); });
    const reader = new ProbeRoutineReader({ get });

    await expect(reader.findPreviewRoutine("workspace-1", "agent-1", "routine-1")).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith("workspace-1", "agent-1", "routine-1");
  });
});
