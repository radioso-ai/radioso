import { describe, expect, it } from "vitest";

import { EmailSkillExecutor } from "../../../src/modules/customerEmail/executor/emailSkillExecutor.js";
import type { CustomerEmailSkillOutcome } from "../../../src/modules/customerEmail/domain.js";
import type { CustomerEmailDeliveryResult } from "../../../src/modules/customerEmail/services/customerEmailDeliveryService.js";
import type { EmailSkillDefinitionRecord } from "../../../src/db/repositories/emailSkillDefinitionRepository.js";

const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

const definition = (overrides: Partial<EmailSkillDefinitionRecord> = {}): EmailSkillDefinitionRecord => ({
  id: "skill-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  connectionId: "connection-1",
  skillName: "support_email_customer",
  mode: "draft",
  boundInputs: { subject: "Follow-up" },
  exposedInputs: {
    to: { slotBinding: "customerEmail" },
    bodyText: { slotBinding: "messageBody" },
  },
  enabled: true,
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
  ...overrides,
});

const dispatch = (
  executor: EmailSkillExecutor,
  collected: Record<string, unknown> = { customerEmail: "customer@example.com", messageBody: "Hello" },
) =>
  executor.dispatch({
    skill: { name: "support_email_customer" },
    collected,
    context: { agentId: "agent-1", workspaceId: "workspace-1" },
    emit: noopEmit,
  });

const buildExecutor = (deliveryResult: CustomerEmailDeliveryResult, record: EmailSkillDefinitionRecord | null = definition()) => {
  const deliveryInputs: unknown[] = [];
  const executor = new EmailSkillExecutor({
    skills: {
      findEnabledByName: async (workspaceId, agentId, skillName) =>
        record && workspaceId === record.workspaceId && agentId === record.agentId && skillName === record.skillName && record.enabled
          ? record
          : null,
    },
    delivery: {
      deliver: async (input) => {
        deliveryInputs.push(input);
        return deliveryResult;
      },
    },
  });
  return { executor, deliveryInputs };
};

describe("EmailSkillExecutor", () => {
  for (const outcome of ["drafted", "sent", "disabled_connection", "needs_reauth", "provider_rejected", "failed"] as const) {
    it(`returns the typed ${outcome} outcome from delivery`, async () => {
      const record = definition({ mode: outcome === "sent" ? "send" : "draft" });
      const { executor, deliveryInputs } = buildExecutor({ outcome, errorCode: outcome === "failed" ? "provider_failed" : undefined }, record);

      const result = await dispatch(executor);

      expect(result.disposition).toBe("settled");
      if (result.disposition === "settled") {
        expect(result.outcome.status).toBe(outcome);
        expect(result.outcome.outputs).not.toHaveProperty("bodyText");
      }
      expect(deliveryInputs).toHaveLength(1);
      expect(deliveryInputs[0]).toMatchObject({
        workspaceId: "workspace-1",
        connectionId: "connection-1",
        mode: record.mode,
        message: {
          to: "customer@example.com",
          subject: "Follow-up",
          bodyText: "Hello",
        },
      });
    });
  }

  it("returns missing_input without calling delivery when required exposed values are absent", async () => {
    const { executor, deliveryInputs } = buildExecutor({ outcome: "drafted" });

    const result = await dispatch(executor, { customerEmail: "customer@example.com" });

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "missing_input", outputs: { missingInputs: ["bodyText"] } },
    });
    expect(deliveryInputs).toHaveLength(0);
  });

  it("fails closed for undefined or disabled skill names", async () => {
    const { executor } = buildExecutor({ outcome: "drafted" }, definition({ enabled: false }));

    const result = await dispatch(executor);

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "failed", outputs: { reason: "skill_not_found" } },
    });
  });
});
