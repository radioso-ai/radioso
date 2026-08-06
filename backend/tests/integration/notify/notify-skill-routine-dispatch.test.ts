import { describe, expect, it, vi } from "vitest";

import { SkillExecutorRegistry } from "../../../src/modules/skills/public.js";
import { RoutineSkillExecutorDispatcher } from "../../../src/modules/routines/public.js";
import { NOTIFY_SKILLS_ADAPTER, NotifyExecutor, NotifyRoutineSkillResolver } from "../../../src/modules/notify/public.js";

const skill = {
  id: "skill-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  skillName: "contact_dmitri",
  kind: "notify" as const,
  targetType: "notify_delivery",
  targetId: null,
  config: {},
  invocationMode: "routine_named" as const,
  enabled: true,
  createdAt: new Date("2026-08-06T00:00:00.000Z"),
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
};

describe("routine notify skill dispatch", () => {
  it("routes an authored notify skill through the shared skill executor registry instead of the external-MCP tail", async () => {
    const enqueue = vi.fn(async () => ({ id: "action-1", duplicate: false }));
    const registry = new SkillExecutorRegistry();
    registry.register({
      kind: "internal",
      adapter: NOTIFY_SKILLS_ADAPTER,
      executor: new NotifyExecutor({
        skills: { findByName: async () => skill },
        outbox: { enqueue },
      }),
    });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new NotifyRoutineSkillResolver([
        { skillName: skill.skillName, enabled: skill.enabled, invocationMode: skill.invocationMode },
      ]),
      registry,
      { workspaceId: "workspace-1" },
    );

    const result = await dispatcher.dispatch({
      skillName: skill.skillName,
      state: {
        sessionId: "session-1",
        routineId: "talk-to-the-team",
        path: ["send"],
        variables: { message: "Please call me", email: "visitor@example.com" },
        attempts: {},
        status: "active",
      },
      turn: {
        sessionId: "session-1",
        agent: { id: "agent-1" },
        inputEvent: { kind: "message", content: "send it" },
        history: [],
        stagedContext: [],
        steering: [],
      },
    });

    // Before the resolver existed, this fell through to the external-MCP tail and
    // McpSkillExecutor failed closed for a name that is not an authored external
    // skill, so the routine took its `outcome: failed` edge (delivery_failed).
    expect(result.status).toBe("delivered");
    expect(result.outputs).toMatchObject({ skillName: skill.skillName, enqueued: true });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "contact.send",
        workspaceId: "workspace-1",
        conversationId: "session-1",
      }),
    );
  });
});
