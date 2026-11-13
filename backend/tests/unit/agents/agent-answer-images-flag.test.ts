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

describe("the agent's answerImagesEnabled flag", () => {
  it("is off until an operator turns it on", () => {
    expect(validateAgentInput({}).answerImagesEnabled).toBe(false);
    expect(validateAgentInput({ answerImagesEnabled: true }).answerImagesEnabled).toBe(true);
  });

  it("is a field of the agent's write body and of a reviewed settings change", () => {
    expect(agentBodySchema.parse({ answerImagesEnabled: true })).toEqual({ answerImagesEnabled: true });
    expect(agentReviewedSettingsPatchSchema.parse({ answerImagesEnabled: true })).toEqual({ answerImagesEnabled: true });
    expect(agentBodySchema.safeParse({ answerImagesEnabled: "yes" }).success).toBe(false);
  });

  it("travels in the agent's portable config, whose version says it can", () => {
    const agent = { ...conversationQualityAgent, answerImagesEnabled: true };

    expect(AGENT_CONFIG_SCHEMA_VERSION).toBe(5);
    expect(serializeAgentConfig(agent).answerImagesEnabled).toBe(true);
    const internal = projectInternalAgentConfig(agent);
    expect(internal.answerImagesEnabled).toBe(true);
    expect(materializeAgentFromConfig(internal, { agentId: agent.id, workspaceId: agent.workspaceId }).answerImagesEnabled).toBe(true);
  });

  it("reads a config written before the flag existed as off", () => {
    const { answerImagesEnabled: _dropped, ...older } = projectInternalAgentConfig({ ...conversationQualityAgent, answerImagesEnabled: true });

    expect(materializeAgentFromConfig(older as Parameters<typeof materializeAgentFromConfig>[0], {
      agentId: conversationQualityAgent.id,
      workspaceId: conversationQualityAgent.workspaceId,
    }).answerImagesEnabled).toBe(false);
  });

  it("is carried into an imported agent", () => {
    const config = serializeAgentConfig({ ...conversationQualityAgent, answerImagesEnabled: true });

    expect(projectAgentConfigForImport(config).input.answerImagesEnabled).toBe(true);
  });
});
