import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { catalogCoverage } from "./catalogCoverage.js";
import { copilotProposalOperationIds } from "../../../src/app/http/openapi/paths/copilotPaths.js";
import { buildCopilotNeverListContext, copilotNeverList } from "../../../src/modules/operatorCopilot/neverList.js";
import { copilotIngestionSettingsChangeSchema } from "../../../src/modules/operatorCopilot/contracts/ingestionSettingsAuthoring.js";

describe("operator copilot catalog coverage", () => {
  // Ratchet: this may only ever decrease as tools land. Every increase so far has been a correction
  // of a wrong *permanent* exclusion, not deferred scope creep:
  //   131 -> 133  ingestion settings, which Wave 3 will make proposable
  // (133 fell to 128 when workspace_settings covered six settings reads; 128 fell to 126 when
  // the routine portable-document routes were removed upstream.)
  //   126 -> 128  getDocumentTypeCatalog/updateDocumentTypeCatalog, the workspace document type
  //               catalog behind metadata extraction. It lands in the same Wave 3 knowledge-base
  //               bucket as the document and source surfaces it configures, so it becomes
  //               proposable with them rather than ahead of them.
  //   128 -> 132  takeOverConversation/transferConversationOwnership/handBackConversation/
  //               resolveDecision, the operator HITL controls behind Needs Attention. They were
  //               filed as an end-user surface alongside the public chat routes, which read as a
  //               boundary and would have let Wave 4 skip the serving controls it exists to give
  //               a runtime safety model.
  //   132 -> 133  when the complete live Eval route family was registered in the public contract.
  //               These are pre-existing dashboard operations, not new Ray backlog: only
  //               listEvalCases is represented by eval_results; the remaining creation,
  //               direct-edit, snapshot, and per-case-run surfaces stay explicitly deferred until
  //               their bounded Ray workflows exist. (The routine authoring and lifecycle
  //               operations landed covered, by propose_routine_edit, propose_routine_lifecycle,
  //               and validate_routine, in this same window, so 133 already reflects them.
  //               deleteAgentRoutine stays deferred on its own ground: edits address stable ids
  //               and cannot remove anything.)
  //   133 -> 130  createAgentSkill/updateAgentSkill moved to propose_skill_config; deleteAgentSkill
  //               keeps its own deferred entry for the destructive removal propose_skill_config
  //               does not reach. deleteAgentDirective moved to propose_directive_removal.
  //   130 -> 121  createContextVariable/updateContextVariable/upsertAgentContextVariable moved to
  //               propose_context_variable; listContextVariables/getContextVariable/
  //               listAgentContextVariables moved to the new context_variables reader; the
  //               per-scope value operations (upsertContextVariableValue/getContextVariableValue/
  //               deleteContextVariableValue) turned out to be a permanent exclusion rather than
  //               deferred scope, since they carry visitor runtime data rather than configuration.
  //   121 -> 118  recrawlDocumentSource, reprocessDocumentSource, and reprocessDocument moved to
  //               the bounded document maintenance acts in the Wave 2 knowledge-base tools.
  //   106 -> 93   when the forty-five workspace, channel, and connector operations were reasoned
  //               one ground at a time; twelve of them were permanent, not deferred.
  const maxDeferredCatalogExclusions = 93;

  it("states each permanent exclusion's own ground rather than one conflated reason", () => {
    // A permanent exclusion is the strongest claim this map makes, so a wrong one either blocks
    // legitimate work or forces a permanent -> covered flip. Both have happened. Pin the grounds
    // apart so a harmless read cannot be filed under "secret-bearing" again.
    const reasonFor = (operationId: string) => {
      const entry = catalogCoverage[operationId];
      return typeof entry === "string" ? "" : entry.reason;
    };

    expect(reasonFor("getApiAccessSummary")).toContain("identity and authorization administration");
    expect(reasonFor("switchAccount")).toContain("does not administer identity");
    expect(reasonFor("listAccountUsers")).toContain("account-scoped");
    // The signing key derives the secret an embed uses to sign visitor identity; it must never
    // become readable, and the context_variables reader and propose_context_variable must never
    // grow a path to it.
    expect(catalogCoverage.getAgentContextVariableSigningKey).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("carries secret material"),
    });

    expect(catalogCoverage.listAgentChannelCredentials).toMatchObject({
      disposition: "permanent",
      neverListEntry: "access_grants",
    });
    expect(catalogCoverage.issueAgentChannelCredential).toMatchObject({
      disposition: "permanent",
      neverListEntry: "access_grants",
    });
  });

  it("maps agent and routine discovery operations to the completed family readers", () => {
    expect(catalogCoverage).toMatchObject({
      listAgents: "agent_configuration",
      listAgentDirectives: "agent_configuration",
      listAgentRoutines: "routine_definition",
    });
  });

  it("maps routine authoring and lifecycle operations to the tools that reach them", () => {
    expect(catalogCoverage).toMatchObject({
      validateAgentRoutine: "validate_routine",
      updateAgentRoutine: "propose_routine_edit",
      publishAgentRoutine: "propose_routine_lifecycle",
      reviseAgentRoutine: "propose_routine_edit",
      archiveAgentRoutine: "propose_routine_lifecycle",
      restoreAgentRoutine: "propose_routine_lifecycle",
    });
    // Editing addresses elements by stable id, so nothing Ray proposes can remove a routine or
    // rework its graph. That is a scope boundary of the edit tool, not a Wave 2 backlog item.
    expect(catalogCoverage.deleteAgentRoutine).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("stable id"),
    });
  });

  it("maps conversation history operations to the bounded transcript reader", () => {
    expect(catalogCoverage).toMatchObject({
      getHistoryConversation: "conversation_transcript",
      tailHistoryConversation: "conversation_transcript",
      getLegacyHistoryConversation: "conversation_transcript",
    });
  });

  it("maps the eval write and batch-run operations to Ray's verification loop", () => {
    // The get-or-create write was filed under the eval *reader* while no tool could call it, which
    // reported the operation as covered by a descriptor that only lists cases.
    expect(catalogCoverage).toMatchObject({
      getEvalCaseBySourceMessage: "eval_results",
      getOrCreateEvalCaseBySourceMessage: "create_eval_case_from_turn",
      runEvalCases: "run_eval_suite",
    });
  });

  it("keeps the one-off replay operation on the ratchet, because a probe reaches only part of it", () => {
    // replay_eval_case derives its snapshot from a case and never attaches the run, so the
    // snapshot-scoped and case-attached halves of createEvalRun remain uncovered. Mapping the
    // operation to the probe would retire a surface no tool actually reaches.
    expect(catalogCoverage.createEvalRun).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("snapshot-scoped replay tool"),
    });
  });

  it("maps the pending-approval queue to the triage digest rather than to the end-user surface", () => {
    // `/decisions` is the dashboard's own approval queue, gated on workspace.conversation.takeover.
    // Filing it under "end-user or inbound integration surface" made an operator read look like a
    // boundary, which is the kind of wrong permanent exclusion this map exists to keep visible.
    expect(catalogCoverage.listPendingDecisions).toBe("workspace_triage");
  });

  it("keeps the operator serving controls on the never-list, each citing its own boundary", () => {
    // These were once filed as an end-user surface, which made an operator control look like
    // somebody else's endpoint. They are permanent, but for a stated reason with a handoff behind
    // it: deciding who answers a waiting customer stays with the person who will answer them.
    for (const operationId of [
      "takeOverConversation",
      "transferConversationOwnership",
      "handBackConversation",
      "forkConversation",
    ]) {
      expect(catalogCoverage[operationId]).toMatchObject({
        disposition: "permanent",
        neverListEntry: "live_conversation_ownership",
      });
    }
    expect(catalogCoverage.resolveDecision).toMatchObject({
      disposition: "permanent",
      neverListEntry: "pending_decision_resolution",
    });
  });

  it("maps the authenticated assistant pipeline to the bounded test-turn probe", () => {
    expect(catalogCoverage.createAssistantChatResponse).toBe("test_agent_turn");
  });

  it("maps safe workspace settings reads to the workspace settings reader", () => {
    expect(catalogCoverage).toMatchObject({
      getPlatformSettings: "workspace_settings",
      getSettingsRetrievalDefaults: "workspace_settings",
      getIngestionSettings: "workspace_settings",
      getGeneralSettings: "workspace_settings",
      listWorkspaceProviderCredentials: "workspace_settings",
      getWorkspaceLlmModels: "workspace_settings",
    });
  });

  it("maps document and source remediation operations to the bounded maintenance acts", () => {
    expect(catalogCoverage).toMatchObject({
      recrawlDocumentSource: "recrawl_source",
      reprocessDocumentSource: "reprocess_document",
      reprocessDocument: "reprocess_document",
    });
  });

  it("maps every OpenAPI operation to a catalog tool or stated exclusion", async () => {
    const openApi = JSON.parse(await readFile(new URL("../../../openapi.json", import.meta.url), "utf8")) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operationIds = Object.values(openApi.paths)
      .flatMap((path) => Object.values(path))
      .flatMap((operation) => operation.operationId ? [operation.operationId] : []);

    // OpenAPI artifacts are generated by the orchestrator. Include newly
    // registered source operation IDs so this remains a useful local gate before
    // that generation step and exact again once artifacts are refreshed.
    expect(Object.keys(catalogCoverage).sort()).toEqual([...new Set([...operationIds, ...copilotProposalOperationIds])].sort());
    for (const entry of Object.values(catalogCoverage)) {
      expect(typeof entry === "string" || ("reason" in entry && entry.reason.trim().length > 0)).toBe(true);
    }
  });

  it("reasons the workspace, channel, and connector surface one ground at a time", () => {
    const wave5OperationIds = [
      "getAccountUsageTrends", "getAccountUsageMessages", "getAccountInternalUsage",
      "listWorkspaces", "createWorkspace", "getWorkspaceSummary", "resolveWorkspaceRouteKey",
      "renameWorkspace", "listWebhookDestinations", "createWebhookDestination",
      "getWebhookDestination", "updateWebhookDestination", "deleteWebhookDestination",
      "updatePlatformSettings", "reprocessWorkspaceIngestion", "updateGeneralSettings",
      "uploadAssistantLogo", "deleteAssistantLogo", "updateWorkspaceLlmModels",
      "startMcpConnectionOauth", "createWorkspaceOauthConnection", "listWorkspaceOauthConnections",
      "getWorkspaceOauthConnection", "reauthorizeWorkspaceOauthConnection",
      "listWorkspaceEmailSkillActivity", "listWorkspaceEmailConnections",
      "createWorkspaceEmailConnection", "listWorkspaceEmailOauthConnections",
      "updateWorkspaceEmailConnection", "deleteWorkspaceEmailConnection",
      "checkWorkspaceEmailConnectionHealth", "startWorkspaceSlackInstall",
      "getWorkspaceSlackInstallStatus", "getWorkspaceSlackManifest", "getWorkspaceSlackBinding",
      "setWorkspaceSlackBinding", "deleteWorkspaceSlackChannelBinding", "listWorkspaceSlackBindings",
      "disconnectWorkspaceSlackInstallation", "listConnectors", "getConnectorDetail",
      "updateConnectorConfig", "enableConnector", "disableConnector", "syncConnector",
    ] as const;

    const entries = wave5OperationIds.map((operationId) => catalogCoverage[operationId]);
    // Every one of these still appears in the map. A covered entry (a plain tool name) is the best
    // outcome a ground can reach; what this pins is that none of them has fallen out of the map
    // entirely, and that nothing still deferred rides on a shared bulk reason.
    expect(entries.every((entry) => entry !== undefined)).toBe(true);
    const reasons = entries.flatMap((entry) => typeof entry === "string" ? [] : [entry.reason]);
    expect(reasons.some((reason) => reason.includes("Deferred to Wave 5 workspace configuration"))).toBe(false);
    expect(new Set(reasons).size).toBeGreaterThanOrEqual(12);
  });

  it("keeps the secret-minting webhook create beside the rotation it shares a response with", () => {
    expect(catalogCoverage.createWebhookDestination).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("carries secret material"),
    });
    expect(catalogCoverage.rotateWebhookDestinationSecret).toMatchObject({
      disposition: "permanent",
      neverListEntry: "secret_rotation",
    });
    expect(catalogCoverage.updateWebhookDestination).toMatchObject({ disposition: "deferred" });
  });

  it("excludes the interactive authorization starts rather than deferring them", () => {
    for (const operationId of [
      "startMcpConnectionOauth",
      "createWorkspaceOauthConnection",
      "reauthorizeWorkspaceOauthConnection",
      "startWorkspaceSlackInstall",
    ]) {
      expect(catalogCoverage[operationId]).toMatchObject({
        disposition: "permanent",
        reason: expect.stringContaining("interactive OAuth consent flow"),
      });
    }
    expect(catalogCoverage.disconnectWorkspaceSlackInstallation).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("stored installation credential"),
    });
    // The non-secret status reads on the same connections stay deferred.
    expect(catalogCoverage.listWorkspaceOauthConnections).toMatchObject({ disposition: "deferred" });
    expect(catalogCoverage.getWorkspaceSlackInstallStatus).toMatchObject({ disposition: "deferred" });
  });

  it("keeps the workspace container and its brand asset out of Ray's reach", () => {
    expect(catalogCoverage.createWorkspace).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("container Ray operates inside"),
    });
    expect(catalogCoverage.renameWorkspace).toMatchObject({ disposition: "permanent" });
    expect(catalogCoverage.listWorkspaces).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("account-scoped"),
    });
    expect(catalogCoverage.resolveWorkspaceRouteKey).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("already resolved"),
    });
    for (const operationId of ["uploadAssistantLogo", "deleteAssistantLogo"]) {
      expect(catalogCoverage[operationId]).toMatchObject({
        disposition: "permanent",
        reason: expect.stringContaining("binary brand asset"),
      });
    }
  });

  it("names the tool shape each remaining Wave 5 deferral waits on", () => {
    // Both endpoints write the same assistant and embed fields through the same service.
    // propose_workspace_setting picks the grouped one as its apply path, which is what makes the
    // flat one a duplicate rather than a second surface to cover.
    expect(catalogCoverage.updatePlatformSettings).toBe("propose_workspace_setting");
    expect(catalogCoverage.updateGeneralSettings).toMatchObject({
      disposition: "permanent",
      reason: expect.stringContaining("same assistant and channel fields"),
    });
    expect(catalogCoverage.updateWorkspaceLlmModels).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("per-capability rows"),
    });
    expect(catalogCoverage.syncConnector).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("act"),
    });
    expect(catalogCoverage.checkWorkspaceEmailConnectionHealth).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("probe"),
    });
    expect(catalogCoverage.reprocessWorkspaceIngestion).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("cost guard"),
    });
    expect(catalogCoverage.getWorkspaceSummary).toMatchObject({
      disposition: "deferred",
      reason: expect.stringContaining("setup"),
    });
  });

  it("does not expand the deferred catalog backlog", () => {
    const deferredExclusionCount = Object.values(catalogCoverage)
      .filter((entry): entry is Exclude<typeof entry, string> => typeof entry !== "string")
      .filter((entry) => entry.disposition === "deferred")
      .length;

    expect(deferredExclusionCount).toBeLessThanOrEqual(maxDeferredCatalogExclusions);
  });

  it("cites the never-list for permanent copilot boundaries", () => {
    expect(catalogCoverage).toMatchObject({
      deleteWorkspace: { disposition: "permanent", neverListEntry: "workspace_delete" },
      createAccountInvitation: { disposition: "permanent", neverListEntry: "member_management" },
      setWorkspaceGrant: { disposition: "permanent", neverListEntry: "access_grants" },
      rotatePersonalApiToken: { disposition: "permanent", neverListEntry: "machine_access" },
      rotateServiceAccountCredential: { disposition: "permanent", neverListEntry: "machine_access" },
      setWorkspaceProviderCredential: { disposition: "permanent", neverListEntry: "provider_credential_writes" },
      replyToConversation: { disposition: "permanent", neverListEntry: "unattended_live_customer_reply" },
    });
  });

  it("keeps never-list exclusions available to Ray's runtime boundary context", () => {
    const runtimeBoundaries = new Set(buildCopilotNeverListContext("acme").map((entry) => entry.boundary));
    const coverageBoundaries = Object.values(catalogCoverage)
      .filter((entry): entry is Exclude<typeof entry, string> => typeof entry !== "string")
      .flatMap((entry) => entry.neverListEntry ? [entry.neverListEntry] : []);

    expect(coverageBoundaries).not.toHaveLength(0);
    expect(coverageBoundaries.every((entry) => runtimeBoundaries.has(entry))).toBe(true);
  });

  it("covers ingestion settings through a proposal while the embedding-model switch stays a boundary", () => {
    // The never-list entry covers the embedding-model switch, not the whole endpoint. The proposal
    // tool carries every other ingestion field and has no embedding-model input at all, which is
    // what keeps the switch behind its typed dashboard confirmation.
    expect(catalogCoverage.updateIngestionSettings).toBe("propose_ingestion_settings");
    expect(copilotIngestionSettingsChangeSchema.safeParse({ embeddingModel: "text-embedding-3-large" }).success).toBe(false);
    expect(copilotNeverList.embedding_model_switch_without_typed_confirmation.reason).toContain("typed operator confirmation");
  });

  it("defers cancelling a pending embedding-model switch as a de-escalation, not a boundary", () => {
    const entry = catalogCoverage.cancelPendingEmbeddingModel;
    expect(entry).toMatchObject({ disposition: "deferred" });
    expect(typeof entry === "string" ? "" : entry.reason).toContain("de-escalation");
  });
});
