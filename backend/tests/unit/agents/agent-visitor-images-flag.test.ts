import { describe, expect, it } from "vitest";

import { agentBodySchema } from "../../../src/app/http/routes/agentRoutes.js";
import { projectAgentConfigForImport } from "../../../src/modules/agentBundle/importProjection.js";
import {
  agentReviewedSettingsPatchSchema,
  materializeAgentFromConfig,
  projectInternalAgentConfig,
  serializeAgentConfig,
  validateAgentInput,
} from "../../../src/modules/agents/public.js";
import { conversationQualityAgent } from "../../fixtures/conversation-quality/agent.js";

describe("the agent's visitorImagesEnabled flag", () => {
  it("is off until an operator turns it on", () => {
    expect(validateAgentInput({}).visitorImagesEnabled).toBe(false);
    expect(validateAgentInput({ visitorImagesEnabled: true }).visitorImagesEnabled).toBe(true);
  });

  it("is a field of the agent's write body and of a reviewed settings change", () => {
    expect(agentBodySchema.parse({ visitorImagesEnabled: true })).toEqual({ visitorImagesEnabled: true });
    expect(agentReviewedSettingsPatchSchema.parse({ visitorImagesEnabled: true })).toEqual({ visitorImagesEnabled: true });
    expect(agentBodySchema.safeParse({ visitorImagesEnabled: "yes" }).success).toBe(false);
  });

  it("travels in the agent's portable config and back", () => {
    const agent = { ...conversationQualityAgent, visitorImagesEnabled: true };

    expect(serializeAgentConfig(agent).visitorImagesEnabled).toBe(true);
    const internal = projectInternalAgentConfig(agent);
    expect(internal.visitorImagesEnabled).toBe(true);
    expect(materializeAgentFromConfig(internal, { agentId: agent.id, workspaceId: agent.workspaceId }).visitorImagesEnabled).toBe(true);
  });

  it("reads a config written before the flag existed as off", () => {
    const { visitorImagesEnabled: _dropped, ...older } = projectInternalAgentConfig({ ...conversationQualityAgent, visitorImagesEnabled: true });

    expect(materializeAgentFromConfig(older as Parameters<typeof materializeAgentFromConfig>[0], {
      agentId: conversationQualityAgent.id,
      workspaceId: conversationQualityAgent.workspaceId,
    }).visitorImagesEnabled).toBe(false);
  });

  it("is carried into an imported agent", () => {
    const config = serializeAgentConfig({ ...conversationQualityAgent, visitorImagesEnabled: true });

    expect(projectAgentConfigForImport(config).input.visitorImagesEnabled).toBe(true);
  });
});
