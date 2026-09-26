import { expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

it("applies an agent-setting proposal drafted before a directive through the copilot proposal lifecycle", async () => {
  const { app, dependencies, repositories } = createTestApp({
    chatInferencePipelineComplete: async () => ({
      text: JSON.stringify({
        directive: {
          name: "Considerate answers",
          condition: { kind: "always" },
          action: "Answer in a considerate, direct tone.",
          surfaces: [],
        },
        diagnosis: "directive_recommended",
        rationale: "Keeps support answers consistent.",
      }),
    }),
  });
  const { workspaceId, accountId, userId } = await issueTestSession(app, "proposal-staleness@example.com");
  const agent = await repositories.agentRepository.create(workspaceId, {
    name: "Support",
    retrievalEnabled: true,
    sourceScope: { mode: "all" },
    assistantDefaultLocale: "en",
  });
  const conversation = await dependencies.copilotRepository.createConversation({
    workspaceId,
    operatorUserId: userId,
    title: "Proposal staleness",
  });
  const context = {
    workspaceId,
    accountId,
    operatorUserId: userId,
    surface: "dashboard" as const,
    copilotConversationId: conversation.id,
    currentAuthorization: { hasAllPermissions: async () => true },
    pageContext: { view: "agent" as const, agentId: agent.id, conversationId: null, selection: null, entities: [] },
  };
  const descriptor = (name: string) => {
    const found = dependencies.copilotToolCatalog.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Expected ${name} in the copilot catalog`);
    return found;
  };

  const setting = await descriptor("propose_agent_setting").createTool(context).invoke({
    agentId: agent.id,
    settingKey: "assistantDefaultLocale",
    value: "et",
  }, {} as never) as { proposalId: string };
  const directive = await descriptor("propose_directive").createTool(context).invoke({
    agentId: agent.id,
    intent: "Always answer in a considerate, direct tone.",
  }, {} as never) as { proposalId: string };

  await expect(dependencies.operatorCopilotService.applyProposal({
    workspaceId, accountId, operatorUserId: userId, surface: "dashboard", proposalId: directive.proposalId,
  })).resolves.toMatchObject({ status: "applied" });
  await expect(dependencies.operatorCopilotService.applyProposal({
    workspaceId, accountId, operatorUserId: userId, surface: "dashboard", proposalId: setting.proposalId,
  })).resolves.toMatchObject({ status: "applied" });

  await expect(dependencies.copilotRepository.findProposal({
    id: setting.proposalId, workspaceId, operatorUserId: userId,
  })).resolves.toMatchObject({ status: "applied" });
  await expect(repositories.agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId))
    .resolves.toMatchObject({ assistantDefaultLocale: "et" });
});

it("refuses a workspace-setting proposal enabling the website embed when a concurrent write clears its origins", async () => {
  // PlatformSettingsService.applyProposalPatch re-validates the enabled/allowedOrigins coupling
  // against the row AgentRepository.applyProposalPatch locks, so a writer that clears the origins
  // between draft and apply must be seen there, not papered over by draft-time origins. This runs
  // the fake-backed InMemoryAgentRepository CAS path (Postgres coverage is in
  // agent-repository.integration.test.ts), so a regression in the fake's guard handling fails here too.
  const { app, dependencies, repositories } = createTestApp();
  const { workspaceId, accountId, userId } = await issueTestSession(app, "embed-origin-race@example.com");
  const agent = await repositories.agentRepository.create(workspaceId, {
    name: "Embed race",
    retrievalEnabled: true,
    sourceScope: { mode: "all" },
    surfaceSettings: { websiteEmbed: { enabled: false, allowedOrigins: ["https://example.com"] } },
  });
  await repositories.agentRepository.setDefault(workspaceId, agent.id);
  const conversation = await dependencies.copilotRepository.createConversation({
    workspaceId,
    operatorUserId: userId,
    title: "Embed origin race",
  });
  const context = {
    workspaceId,
    accountId,
    operatorUserId: userId,
    surface: "dashboard" as const,
    copilotConversationId: conversation.id,
    currentAuthorization: { hasAllPermissions: async () => true },
    pageContext: { view: "agent" as const, agentId: agent.id, conversationId: null, selection: null, entities: [] },
  };
  const descriptor = (name: string) => {
    const found = dependencies.copilotToolCatalog.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Expected ${name} in the copilot catalog`);
    return found;
  };

  const proposal = await descriptor("propose_workspace_setting").createTool(context).invoke({
    websiteEmbedEnabled: true,
  }, {} as never) as { proposalId: string };

  // A second writer clears the allowed origins after the proposal was drafted.
  await repositories.agentRepository.update(agent.id, workspaceId, {
    surfaceSettings: { websiteEmbed: { allowedOrigins: [] } },
  });

  await expect(dependencies.operatorCopilotService.applyProposal({
    workspaceId, accountId, operatorUserId: userId, surface: "dashboard", proposalId: proposal.proposalId,
  })).resolves.toMatchObject({ status: "failed", reason: expect.stringMatching(/allowed origin/i) });

  await expect(repositories.agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId))
    .resolves.toMatchObject({ surfaceSettings: { websiteEmbed: { enabled: false, allowedOrigins: [] } } });
});
