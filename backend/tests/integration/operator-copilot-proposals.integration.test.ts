import { randomUUID } from "node:crypto";

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

it("lets an Operator MCP client set up the website embed while the token stays behind a dashboard link", async () => {
  const { app, dependencies, repositories } = createTestApp();
  const { workspaceId, accountId, userId } = await issueTestSession(app, "mcp-embed-setup@example.com");
  const agent = await repositories.agentRepository.create(workspaceId, {
    name: "Embed setup",
    retrievalEnabled: true,
    sourceScope: { mode: "all" },
  });
  await repositories.agentRepository.setDefault(workspaceId, agent.id);
  // A direct Operator MCP call: no Ray conversation, only the invocation that drafted it.
  const mcpContext = {
    workspaceId,
    accountId,
    operatorUserId: userId,
    surface: "mcp" as const,
    operatorMcpInvocationId: randomUUID(),
    currentAuthorization: { hasAllPermissions: async () => true },
    pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
  };
  const descriptor = (name: string) => {
    const found = dependencies.copilotToolCatalog.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Expected ${name} in the copilot catalog`);
    return found;
  };

  const proposal = await descriptor("propose_workspace_setting").createTool(mcpContext).invoke({
    websiteEmbedEnabled: true,
    websiteEmbedAllowedOrigins: ["https://shop.example.com"],
  }, {} as never) as { proposalId: string; reach?: boolean };
  expect(proposal.reach).toBe(true);
  await expect(dependencies.copilotRepository.findProposal({ id: proposal.proposalId, workspaceId, operatorUserId: userId }))
    .resolves.toMatchObject({ conversationId: null, origin: { type: "operator_mcp_invocation", invocationId: mcpContext.operatorMcpInvocationId } });

  // The operator still applies the reach change in the dashboard.
  await expect(dependencies.operatorCopilotService.applyProposal({
    workspaceId, accountId, operatorUserId: userId, surface: "dashboard", proposalId: proposal.proposalId,
  })).resolves.toMatchObject({ status: "applied" });
  const enabled = await repositories.agentRepository.findByIdAndWorkspaceId(agent.id, workspaceId);
  expect(enabled?.surfaceSettings.websiteEmbed).toMatchObject({ enabled: true, allowedOrigins: ["https://shop.example.com"] });
  const token = enabled?.surfaceSettings.websiteEmbed.token;
  expect(token).toEqual(expect.any(String));

  const settings = await descriptor("workspace_settings").createTool(mcpContext).invoke({}, {} as never) as {
    general: { channels: { websiteEmbedEnabled: boolean; websiteEmbedSnippetUrl: string } };
  };
  expect(settings.general.channels.websiteEmbedEnabled).toBe(true);
  const snippetUrl = new URL(settings.general.channels.websiteEmbedSnippetUrl);
  expect(snippetUrl.pathname).toMatch(new RegExp(`^/w/[^/]+/agents/${agent.id}$`));
  expect(snippetUrl.search).toBe("?tab=channels&anchor=web-chat");
  expect(JSON.stringify(settings)).not.toContain(token);
});

it("lets an Operator MCP client read, route, and check which notify skill sends a routine ending's notice", async () => {
  const { app, dependencies } = createTestApp();
  const ownerEmail = "notice-routing-owner@example.com";
  const { workspaceId, accountId, userId } = await issueTestSession(app, ownerEmail);
  const agentId = (await dependencies.agentService.listExisting(workspaceId))[0].id;
  for (const [name, recipient] of [["notify_bookings", "francesco@example.com"], ["notify_sales", "sales@example.com"]] as const) {
    await dependencies.agentSkillsService.create(workspaceId, agentId, {
      name,
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: [recipient], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
  }
  const { routine } = await dependencies.routineDefinitionService.createDraft(workspaceId, agentId, {
    name: "book-a-stay",
    enabled: true,
    activation: { triggerDescription: "A guest wants to book a stay", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
    slots: [],
    steps: [{ stableStepId: "ask_dates", kind: "chat", instruction: "Ask for the dates.", toolRef: null, ordinal: 0, metadata: {} }],
    transitions: [{ fromStep: "ask_dates", toRef: "booked", guardKind: "default", guardText: null, ordinal: 0 }],
    terminals: [{ stableStepId: "booked", kind: "handoff", instruction: null, operatorNotice: { subject: null, intro: null, skillName: "notify_bookings" }, ordinal: 0 }],
  });
  const mcpContext = {
    workspaceId,
    accountId,
    operatorUserId: userId,
    surface: "mcp" as const,
    operatorMcpInvocationId: randomUUID(),
    operatorMcpGrantId: randomUUID(),
    operatorMcpClientId: "notice-routing-client",
    currentAuthorization: { hasAllPermissions: async () => true },
    pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
  };
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const found = dependencies.copilotToolCatalog.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Expected ${name} in the copilot catalog`);
    expect(found.mcpDisposition?.status).toBe("eligible");
    return found.createTool({ ...mcpContext, operatorMcpInvocationId: randomUUID() }).invoke(input, {} as never);
  };
  const endingSkill = async () => {
    const read = await invoke("routine_definition", { agentId, routineId: routine.id }) as {
      routine: { editable: { endings: Array<{ operatorNotice: { skillName: string | null } | null }> } };
    };
    return read.routine.editable.endings[0]?.operatorNotice?.skillName;
  };

  // Read which skill sends the notice, and where each choice sends.
  expect(await endingSkill()).toBe("notify_bookings");
  const destinations = await invoke("operator_notice_destinations", { agentId }) as {
    default: { via: string; recipientEmails: string[] };
    skills: Array<{ skillName: string; via: string; recipientEmails: string[] }>;
  };
  expect(destinations.default).toMatchObject({ via: "workspace_owner", recipientEmails: [ownerEmail] });
  expect(destinations.skills).toEqual(expect.arrayContaining([
    expect.objectContaining({ skillName: "notify_bookings", via: "named_skill", recipientEmails: ["francesco@example.com"] }),
    expect.objectContaining({ skillName: "notify_sales", via: "named_skill", recipientEmails: ["sales@example.com"] }),
  ]));

  // Route it through another skill with a reviewed structural edit, then read it back.
  const previous = routine.terminals[0];
  const prepared = await invoke("prepare_routine_structure", {
    kind: "edit",
    agentId,
    routineId: routine.id,
    operations: [{
      kind: "replace_terminal",
      previous,
      next: { ...previous, operatorNotice: { subject: null, intro: null, skillName: "notify_sales" } },
    }],
  }) as { proposalId: string; reviewDigest: string };
  const executed = await invoke("execute_reviewed_proposal", { proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest }) as { status: string };
  expect(executed.status).toBe("applied");
  expect(await endingSkill()).toBe("notify_sales");

  // Send it back to the default destination with a routine edit proposal.
  const proposal = await invoke("propose_routine_edit", {
    agentId,
    routineId: routine.id,
    changes: { terminals: [{ stableStepId: "booked", operatorNotice: { skillName: null } }] },
  }) as { proposalId: string };
  await expect(dependencies.operatorCopilotService.applyProposal({
    workspaceId, accountId, operatorUserId: userId, surface: "dashboard", proposalId: proposal.proposalId,
  })).resolves.toMatchObject({ status: "applied" });
  expect(await endingSkill()).toBeNull();

  // A skill the agent does not have is reported before it can be published.
  const { id: _id, agentId: _agentId, lineageId: _lineageId, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...current } =
    await dependencies.routineDefinitionService.get(workspaceId, agentId, routine.id);
  await dependencies.routineDefinitionService.updateDraft(workspaceId, agentId, routine.id, {
    ...current,
    terminals: current.terminals.map((terminal) => ({ ...terminal, operatorNotice: { subject: null, intro: null, skillName: "notify_nobody" } })),
  });
  const validation = await invoke("validate_routine", { agentId, routineId: routine.id }) as {
    ok: boolean;
    diagnostics: Array<{ code: string; location: string }>;
  };
  expect(validation.ok).toBe(false);
  expect(validation.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "operator_notice_skill_unavailable", location: "step:booked.operatorNotice.skillName" }),
  ]));
});
