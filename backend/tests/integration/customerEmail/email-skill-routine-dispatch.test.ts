import { describe, expect, it } from "vitest";

import { SkillExecutorRegistry } from "../../../src/modules/skills/public.js";
import { RoutineSkillExecutorDispatcher } from "../../../src/modules/routines/public.js";
import { CustomerEmailRoutineSkillResolver } from "../../../src/modules/customerEmail/routineSkillResolver.js";
import { CUSTOMER_EMAIL_SKILLS_ADAPTER, EmailSkillExecutor } from "../../../src/modules/customerEmail/executor/emailSkillExecutor.js";
import type { EmailSkillDefinitionRecord } from "../../../src/db/repositories/emailSkillDefinitionRepository.js";

const record: EmailSkillDefinitionRecord = {
  id: "skill-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  connectionId: "connection-1",
  skillName: "support_email_customer",
  mode: "send",
  boundInputs: { subject: "Follow-up", bodyText: "Hello" },
  exposedInputs: { to: { slotBinding: "email" } },
  enabled: true,
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
};

describe("routine customer email skill dispatch", () => {
  it("routes authored email skills through the shared skill executor registry and preserves typed outcomes", async () => {
    const registry = new SkillExecutorRegistry();
    registry.register({
      kind: "internal",
      adapter: CUSTOMER_EMAIL_SKILLS_ADAPTER,
      executor: new EmailSkillExecutor({
        skills: { findEnabledByName: async () => record },
        delivery: { deliver: async () => ({ outcome: "sent", providerMessageId: "provider-1" }) },
      }),
    });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new CustomerEmailRoutineSkillResolver([record.skillName]),
      registry,
      { workspaceId: "workspace-1" },
    );

    const result = await dispatcher.dispatch({
      skillName: record.skillName,
      state: {
        sessionId: "session-1",
        routineId: "routine-1",
        path: ["email_step"],
        variables: { email: "customer@example.com" },
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

    expect(result).toEqual({
      status: "sent",
      outputs: {
        skillName: record.skillName,
        mode: "send",
        providerMessageId: "provider-1",
      },
      answer: undefined,
    });
  });
});
