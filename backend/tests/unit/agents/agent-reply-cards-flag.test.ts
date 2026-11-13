import { describe, expect, it } from "vitest";

import { agentBodySchema } from "../../../src/app/http/routes/agentRoutes.js";
import { projectAgentConfigForImport } from "../../../src/modules/agentBundle/importProjection.js";
import {
  AGENT_CONFIG_SCHEMA_VERSION,
  agentReviewedSettingsPatchSchema,
  materializeAgentFromConfig,
  projectInternalAgentConfig,
  serializeAgentConfig,
  validateAgentInput,
} from "../../../src/modules/agents/public.js";
import { conversationQualityAgent } from "../../fixtures/conversation-quality/agent.js";

describe("the agent's replyCardsEnabled switch", () => {
  it("is off until an operator turns it on", () => {
    expect(validateAgentInput({}).replyCardsEnabled).toBe(false);
    expect(validateAgentInput({ replyCardsEnabled: true }).replyCardsEnabled).toBe(true);
  });

  it("is a field of the agent's write body and of a reviewed settings change", () => {
    expect(agentBodySchema.parse({ replyCardsEnabled: true })).toEqual({ replyCardsEnabled: true });
    expect(agentReviewedSettingsPatchSchema.parse({ replyCardsEnabled: true })).toEqual({ replyCardsEnabled: true });
    expect(agentBodySchema.safeParse({ replyCardsEnabled: "yes" }).success).toBe(false);
  });

  it("travels in the agent's portable config, whose version says it can", () => {
    const agent = { ...conversationQualityAgent, replyCardsEnabled: true };

    expect(AGENT_CONFIG_SCHEMA_VERSION).toBe(5);
    expect(serializeAgentConfig(agent).replyCardsEnabled).toBe(true);
    const internal = projectInternalAgentConfig(agent);
    expect(internal.replyCardsEnabled).toBe(true);
    expect(materializeAgentFromConfig(internal, { agentId: agent.id, workspaceId: agent.workspaceId }).replyCardsEnabled).toBe(true);
  });

  it("reads a config written before the flag existed as off", () => {
    const { replyCardsEnabled: _dropped, ...older } = projectInternalAgentConfig({ ...conversationQualityAgent, replyCardsEnabled: true });

    expect(materializeAgentFromConfig(older as Parameters<typeof materializeAgentFromConfig>[0], {
      agentId: conversationQualityAgent.id,
      workspaceId: conversationQualityAgent.workspaceId,
    }).replyCardsEnabled).toBe(false);
  });

  it("is carried into an imported agent", () => {
    const config = serializeAgentConfig({ ...conversationQualityAgent, replyCardsEnabled: true });

    expect(projectAgentConfigForImport(config).input.replyCardsEnabled).toBe(true);
  });
});
