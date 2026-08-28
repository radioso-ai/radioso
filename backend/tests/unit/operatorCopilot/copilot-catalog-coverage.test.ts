import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { catalogCoverage } from "./catalogCoverage.js";
import { copilotProposalOperationIds } from "../../../src/app/http/openapi/paths/copilotPaths.js";
import { buildCopilotNeverListContext } from "../../../src/modules/operatorCopilot/neverList.js";

describe("operator copilot catalog coverage", () => {
  // Ratchet: this may only ever decrease as tools land. Every increase so far has been a correction
  // of a wrong *permanent* exclusion, not deferred scope creep:
  //   131 -> 133  ingestion settings, which Wave 3 will make proposable
  //   128 -> 129  listAgentMcpConverseGrants, documented as carrying no token material, whose
  //               siblings listMcpConnections/getMcpConnection are already agent_skills reads
  // (133 fell to 128 in between, when workspace_settings covered six settings reads; 129 fell to
  // 126 when the routine portable-document routes were removed upstream.)
  //   126 -> 128  getDocumentTypeCatalog/updateDocumentTypeCatalog, the workspace document type
  //               catalog behind metadata extraction. It lands in the same Wave 3 knowledge-base
  //               bucket as the document and source surfaces it configures, so it becomes
  //               proposable with them rather than ahead of them.
  //   128 -> 132  takeOverConversation/transferConversationOwnership/handBackConversation/
  //               resolveDecision, the operator HITL controls behind Needs Attention. They were
  //               filed as an end-user surface alongside the public chat routes, which read as a
  //               boundary and would have let Wave 4 skip the serving controls it exists to give
  //               a runtime safety model.
  //   132 -> 126  the routine authoring and lifecycle operations, covered by propose_routine_edit,
  //               propose_routine_lifecycle, and validate_routine. deleteAgentRoutine stays
  //               deferred on its own ground: edits address stable ids and cannot remove anything.
  // 126 -> 133 when the complete live Eval route family was registered in the
  // public contract. These are pre-existing dashboard operations, not new Ray
  // backlog: only listEvalCases is represented by eval_results; the remaining
  // creation, direct-edit, snapshot, and per-case-run surfaces stay explicitly
  // deferred until their bounded Ray workflows exist.
  const maxDeferredCatalogExclusions = 133;

  it("states each permanent exclusion's own ground rather than one conflated reason", () => {
    // A permanent exclusion is the strongest claim this map makes, so a wrong one either blocks
    // legitimate work or forces a permanent -> covered flip. Both have happened. Pin the grounds
    // apart so a harmless read cannot be filed under "secret-bearing" again.
    const reasonFor = (operationId: string) => {
      const entry = catalogCoverage[operationId];
      return typeof entry === "string" ? "" : entry.reason;
    };

    expect(reasonFor("getWorkspaceApiToken")).toContain("carries secret material");
    expect(reasonFor("switchAccount")).toContain("does not administer identity");
    expect(reasonFor("listAccountUsers")).toContain("account-scoped");
    expect(reasonFor("getWorkspaceMcpContext")).toContain("workspace-token integration clients");

    // Grant metadata carries no token material and its siblings are already readable, so it is
    // planned work rather than a boundary. Issuing and revoking grants stay never-list.
    expect(catalogCoverage.listAgentMcpConverseGrants).toMatchObject({ disposition: "deferred" });
    expect(catalogCoverage.issueAgentMcpConverseGrant).toMatchObject({
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

  it("defers the operator serving controls rather than excluding them as an end-user surface", () => {
    // Every one of these is gated on workspace.conversation.takeover and driven from the operator's
    // own Needs Attention queue. Filed as permanent, they claimed a boundary Ray does not have.
    for (const operationId of [
      "takeOverConversation",
      "transferConversationOwnership",
      "handBackConversation",
      "resolveDecision",
    ]) {
      expect(catalogCoverage[operationId]).toMatchObject({
        disposition: "deferred",
        reason: expect.stringContaining("Wave 4 serving work"),
      });
    }
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
      rotateWorkspaceApiToken: { disposition: "permanent", neverListEntry: "secret_rotation" },
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

  it("defers ingestion settings rather than excluding them, while keeping the embedding-model guard visible", () => {
    // The never-list entry covers the embedding-model switch inside a future proposal, not the whole
    // endpoint: Wave 3 makes ingestion settings proposable, and cancelling a pending model change is
    // a safe de-escalation rather than a boundary.
    for (const operationId of ["updateIngestionSettings", "cancelPendingEmbeddingModel"]) {
      const entry = catalogCoverage[operationId];
      expect(entry).toMatchObject({ disposition: "deferred" });
      expect(typeof entry === "string" ? "" : entry.reason).toContain("Embedding-model changes require");
    }
  });
});
