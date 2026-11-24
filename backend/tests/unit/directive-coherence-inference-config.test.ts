import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceLlmCapabilityResolver } from "../../src/app/composition/workspaceLlmCapabilityResolver.js";
import type { WorkspaceLlmCapabilityPreference } from "../../src/modules/settings/contracts/llmCapability.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../src/shared/infra/llm/providerRegistry.js";

/**
 * The starter pack's coherence context token covers every input the coherence check reads, but
 * not the workspace's provider/model preference. That is correct only because the chat inference
 * pipeline the coherence checker runs on (`skillsRoutines.ts`, `createConversationModelGateway`)
 * pins the deployment's chat provider and model, so a workspace preference change cannot alter
 * which model judges coherence. If this test starts failing, the pipeline began honouring the
 * workspace preference, and the resolved provider/model must be added to the coherence input
 * (`buildCoherenceCheckInput`) and its token.
 */
describe("directive coherence inference configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the deployment's chat model whatever the workspace's chat preference is, before and after it changes", async () => {
    const deployment = resolveLlmConfig({});
    const preferences: WorkspaceLlmCapabilityPreference[] = [
      { workspaceId: "ws-1", capability: "chat", provider: "openai", model: "gpt-4.1", updatedAt: new Date() },
    ];
    const resolver = new WorkspaceLlmCapabilityResolver({
      defaults: deployment,
      settings: {
        getPreference: async (workspaceId, capability) =>
          preferences.find((row) => row.workspaceId === workspaceId && row.capability === capability) ?? null,
      },
      credentials: {
        getApiKey: async () => "workspace-openai-key",
        hasCredentials: async () => true,
        getOpenAIResidency: async () => "global",
      },
      envKeys: { resolveEnvApiKey: () => undefined },
    });
    const requestedModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => {
      requestedModels.push((JSON.parse(init.body ?? "{}") as { model?: string }).model ?? "");
      return Response.json({
        choices: [{ message: { content: '{"verdict":"coherent","conflicts":[],"rationale":"ok"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const pipeline = new LlmProviderRegistry(deployment, undefined, { resolver }).createChatInferencePipeline();
    // The same call the coherence gateway makes.
    const coherenceCall = () => pipeline.complete({
      prompt: "user: {}",
      systemPrompt: "Coherence review.",
      operation: { workspaceId: "ws-1", agentId: "agent-1", surface: "agents", operation: "directive_coherence", attemptKey: "candidate" },
    });

    // Sanity: the preference is real, and a caller that does not pin the model would get it.
    expect(await resolver.resolve("chat", { workspaceId: "ws-1" })).toMatchObject({ model: "gpt-4.1" });

    await coherenceCall(); // as at assessment time
    preferences[0] = { ...preferences[0], model: "gpt-4.1-mini", updatedAt: new Date() };
    await coherenceCall(); // as it would be after the workspace preference changed

    expect(requestedModels).toEqual([deployment.chat.model, deployment.chat.model]);
    expect(deployment.chat.model).not.toBe("gpt-4.1");
  });
});
