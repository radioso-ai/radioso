import { describe, expect, it, vi } from "vitest";

import { createDefaultApplicationComposition } from "../../src/app/composition/defaultComposition.js";
import { buildRoutineAuthoringServices } from "../../src/app/server/builders/skillsRoutines.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
} from "../../src/modules/routines/public.js";
import type { SkillAuthoringCatalog } from "../../src/modules/skills/public.js";
import type { ContextVariableEnablementReaderPort } from "../../src/modules/context-variables/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const routineWithAction = (actionType: string): RoutineDefinition => {
  const now = new Date("2026-10-02T00:00:00.000Z");
  return {
    id: "33333333-3333-4333-8333-333333333333",
    agentId,
    lineageId: "44444444-4444-4444-8444-444444444444",
    version: 1,
    ...routineDefinitionDraftInputSchema.parse({
      name: "notify-team",
      enabled: true,
      activation: {
        triggerDescription: "The visitor needs the team to follow up.",
        gateRef: null,
        priority: 0,
        reentryMode: "once_per_conversation",
      },
      slots: [],
      steps: [{
        stableStepId: "send_notice",
        kind: "action",
        instruction: "Send the action.",
        toolRef: null,
        actionType,
        ordinal: 0,
        metadata: {},
      }],
      transitions: [{
        fromStep: "send_notice",
        toRef: "complete",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: "complete",
        kind: "complete",
        instruction: "Complete the request.",
        ordinal: 0,
      }],
    }),
    createdAt: now,
    updatedAt: now,
  };
};

describe("routine authoring services builder", () => {
  it("uses the authorable action map while explaining host-queued notices", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const composition = createDefaultApplicationComposition({ logger });
    const unused = async (): Promise<never> => {
      throw new Error("not used by routine validation");
    };
    const skillAuthoringCatalog: SkillAuthoringCatalog = {
      listForAgent: async () => [],
      getForAgent: unused,
    };
    const contextVariableReader: ContextVariableEnablementReaderPort = {
      listByAgent: async () => [],
    };
    const { routineDefinitionService } = buildRoutineAuthoringServices({
      agentSkillRepository: {} as never,
      chatInferencePipeline: {} as never,
      composition,
      contextVariableReader,
      infrastructure: {
        auditService: { record: async () => undefined },
        telemetryService: { emit: async () => undefined },
      } as never,
      logger: logger as never,
      repositories: {
        agentRepository: {},
        routineDefinitionRepository: {},
      } as never,
      routineInvocableSkillNames: { listForAgent: async () => [], listByKindForAgent: unused },
      routineTriggerEmbeddingService: {} as never,
      skillAuthoringCatalog,
      webhookDestinations: { existsByIdAndWorkspace: async () => false },
    });

    const hostQueuedValidation = await routineDefinitionService.validateForServing(
      workspaceId,
      routineWithAction("handoff.notify"),
    );
    const contactSendValidation = await routineDefinitionService.validateForServing(
      workspaceId,
      routineWithAction("contact.send"),
    );

    expect(hostQueuedValidation.diagnostics).toContainEqual(expect.objectContaining({
      code: "unregistered_action_type",
      location: "step:send_notice",
      message: expect.stringContaining("routine's ending"),
    }));
    expect(contactSendValidation.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "unregistered_action_type",
    }));
  });
});
