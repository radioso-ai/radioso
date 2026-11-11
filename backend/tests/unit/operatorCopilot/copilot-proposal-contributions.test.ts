import { describe, expect, it, vi } from "vitest";

import {
  copilotProposalPermissions,
  copilotProposalTargetTypes,
  firstPartyCopilotProposalTargetTypes,
  resolveCopilotProposalContributions,
  type CopilotProposal,
} from "../../../src/modules/operatorCopilot/public.js";
import { presentProposalCard, proposalCardFromTrace } from "../../../src/modules/operatorCopilot/proposalCard.js";
import { createContributedProposalToolContributions } from "../../../src/modules/operatorCopilot/tools/contributedProposals.js";
import { createProposalDetailTool } from "../../../src/modules/operatorCopilot/tools/proposalDetail.js";
import {
  ALERT_THRESHOLD_PRESENTATION,
  ALERT_THRESHOLD_TARGET_TYPE,
  ALERT_THRESHOLD_TOOL,
  createAlertThresholdContribution,
  createAlertThresholdState,
} from "../../support/contributedProposalModule.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const PROPOSAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const storedProposal = (input: Record<string, unknown>): CopilotProposal => ({
  id: PROPOSAL_ID,
  workspaceId: "workspace-1",
  operatorUserId: "operator-1",
  origin: { type: "conversation", conversationId: "conversation-1" },
  conversationId: "conversation-1",
  operatorMcpInvocationId: null,
  messageId: "message-1",
  reviewDigest: null,
  reviewSnapshot: null,
  expiresAt: null,
  executionInvocationId: null,
  evidence: null,
  status: "pending",
  reason: null,
  appliedRef: null,
  createdAt: new Date("2026-11-11T10:00:00.000Z"),
  updatedAt: new Date("2026-11-11T10:00:00.000Z"),
  ...input,
} as CopilotProposal);

/** Ray's propose tool for the contributed adapter, over a repository that keeps what it was given. */
const contributedTool = () => {
  const state = createAlertThresholdState();
  const contribution = createAlertThresholdContribution(state);
  const resolved = resolveCopilotProposalContributions([contribution]);
  const created: CopilotProposal[] = [];
  const createProposal = vi.fn(async (input: Record<string, unknown>) => {
    const proposal = storedProposal(input);
    created.push(proposal);
    return proposal;
  });
  const auditService = { record: vi.fn(async () => undefined) };
  const [toolContribution] = createContributedProposalToolContributions(resolved.contributions, {
    proposalRepository: { createProposal },
    auditService,
  });
  const descriptor = toolContribution?.descriptors[0];
  if (!descriptor) throw new Error("No contributed proposal descriptor");
  return { state, resolved, descriptor, created, createProposal, auditService };
};

describe("the proposal target-type set", () => {
  it("is the first-party list, with its permissions, when nothing is contributed", () => {
    const { targetTypes, adapters } = resolveCopilotProposalContributions([]);

    expect(targetTypes.targetTypes).toEqual([...copilotProposalTargetTypes]);
    expect(firstPartyCopilotProposalTargetTypes.targetTypes).toEqual([...copilotProposalTargetTypes]);
    expect(targetTypes.permissionsFor("privacy_setting")).toEqual(copilotProposalPermissions.privacy_setting);
    expect(targetTypes.has(ALERT_THRESHOLD_TARGET_TYPE)).toBe(false);
    expect(adapters).toEqual([]);
  });

  it("adds a contributed target type with the permissions its contribution declares", () => {
    const { targetTypes, adapters } = resolveCopilotProposalContributions([createAlertThresholdContribution(createAlertThresholdState())]);

    expect(targetTypes.targetTypes).toEqual([...copilotProposalTargetTypes, ALERT_THRESHOLD_TARGET_TYPE]);
    expect(targetTypes.has(ALERT_THRESHOLD_TARGET_TYPE)).toBe(true);
    expect(targetTypes.permissionsFor(ALERT_THRESHOLD_TARGET_TYPE)).toEqual({ read: ["workspace.settings.read"], manage: ["workspace.settings.manage"] });
    expect(adapters.map((adapter) => adapter.targetType)).toEqual([ALERT_THRESHOLD_TARGET_TYPE]);
  });

  it("refuses a contribution that claims a first-party target type, so nothing shadows a first-party adapter", () => {
    const state = createAlertThresholdState();

    expect(() => resolveCopilotProposalContributions([
      createAlertThresholdContribution(state, { moduleId: "shadowing-module", adapter: { targetType: "directive" } }),
    ])).toThrow(/"shadowing-module".*first-party target type "directive"/u);
  });

  it("refuses two contributions that claim the same target type", () => {
    const state = createAlertThresholdState();

    expect(() => resolveCopilotProposalContributions([
      createAlertThresholdContribution(state, { moduleId: "first-alerts" }),
      createAlertThresholdContribution(state, { moduleId: "second-alerts" }),
    ])).toThrow(/"second-alerts".*"alert_threshold".*"first-alerts"/u);
  });

  it("refuses an adapter that does not say whether an interrupted apply may be retried", () => {
    const state = createAlertThresholdState();

    expect(() => resolveCopilotProposalContributions([
      createAlertThresholdContribution(state, { adapter: { canRetryAfterInterruptedApply: undefined as never } }),
    ])).toThrow(/canRetryAfterInterruptedApply/u);
  });

  it("refuses a contribution with no permission to read or to apply its proposals", () => {
    const state = createAlertThresholdState();

    expect(() => resolveCopilotProposalContributions([
      createAlertThresholdContribution(state, { adapter: { permissions: { read: ["workspace.settings.read"], manage: [] as never } } }),
    ])).toThrow(/manage permission/u);
  });

  it("refuses a target type that is not a lowercase identifier", () => {
    const state = createAlertThresholdState();

    expect(() => resolveCopilotProposalContributions([
      createAlertThresholdContribution(state, { adapter: { targetType: "Alert Threshold" } }),
    ])).toThrow(/target type/u);
  });
});

describe("a contributed proposal", () => {
  it("is drafted through Ray's propose tool, gated on the permission applying it takes", () => {
    const { descriptor } = contributedTool();

    expect(descriptor).toMatchObject({
      name: ALERT_THRESHOLD_TOOL,
      shape: "propose",
      contributingModule: "test-alerts",
      requiredPermissions: ["workspace.settings.manage"],
      dashboardSubject: { type: "proposal" },
      mcpDisposition: { status: "excluded" },
    });
  });

  it("stores the card's label, sentence and dashboard link on the payload, beside the change the adapter owns", async () => {
    const { descriptor, createProposal, auditService } = contributedTool();

    const output = await descriptor.createTool(context).invoke({ threshold: 500 }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      operatorUserId: "operator-1",
      origin: { type: "conversation", conversationId: "conversation-1" },
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      targetRef: {},
      versionToken: "create",
      evidence: null,
      payload: {
        name: "Alert at 500 answers",
        summary: "Alert the workspace once it uses 500 answers this month.",
        presentation: ALERT_THRESHOLD_PRESENTATION,
        change: { threshold: 500 },
      },
    }));
    expect(output).toEqual({
      proposalId: PROPOSAL_ID,
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      targetLabel: "Alert at 500 answers",
      summary: "Alert the workspace once it uses 500 answers this month.",
      presentation: ALERT_THRESHOLD_PRESENTATION,
    });
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.created",
      metadata: expect.objectContaining({ proposalId: PROPOSAL_ID, targetType: ALERT_THRESHOLD_TARGET_TYPE }),
    }));
  });

  it("streams the same card it reloads as, dashboard link included", async () => {
    const { descriptor, created, resolved } = contributedTool();
    const output = await descriptor.createTool(context).invoke({ threshold: 500 }, {} as never);

    const live = proposalCardFromTrace({ kind: "tool_call_completed", callId: "call-1", toolName: ALERT_THRESHOLD_TOOL, output } as never, resolved.targetTypes);
    const reloaded = presentProposalCard(created[0]);

    expect(live).toEqual({
      id: PROPOSAL_ID,
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      targetLabel: "Alert at 500 answers",
      summary: "Alert the workspace once it uses 500 answers this month.",
      status: "pending",
      presentation: ALERT_THRESHOLD_PRESENTATION,
    });
    expect(reloaded).toEqual({ ...live, reason: null });
  });

  it("is no card at all to a deployment that does not know its target type", async () => {
    const { descriptor } = contributedTool();
    const output = await descriptor.createTool(context).invoke({ threshold: 500 }, {} as never);

    expect(proposalCardFromTrace({ kind: "tool_call_completed", callId: "call-1", toolName: ALERT_THRESHOLD_TOOL, output } as never, firstPartyCopilotProposalTargetTypes)).toBeNull();
  });

  it("refuses a draft whose dashboard link leaves the workspace dashboard", async () => {
    // The dashboard prefixes the path with the workspace root, so a dot segment, raw or
    // percent-encoded, would walk out of the workspace once a browser resolves it.
    for (const dashboardPath of ["https://elsewhere.example/settings", "//elsewhere.example/settings", "settings", "/\\elsewhere.example", "/../../login", "/%2e%2e/%2E%2E/login", "/./../w/other/agents"]) {
      const state = createAlertThresholdState();
      const contribution = createAlertThresholdContribution(state, {
        adapter: {
          async draft() {
            return { targetRef: {}, change: { threshold: 1 }, versionToken: "create", targetLabel: "Alert", summary: "Alert.", presentation: { label: "usage alerts", dashboardPath } };
          },
        },
      });
      const createProposal = vi.fn();
      const [toolContribution] = createContributedProposalToolContributions(resolveCopilotProposalContributions([contribution]).contributions, {
        proposalRepository: { createProposal },
        auditService: { record: vi.fn(async () => undefined) },
      });

      await expect(toolContribution.descriptors[0].createTool(context).invoke({ threshold: 1 }, {} as never)).rejects.toThrow(/dashboardPath/u);
      expect(createProposal).not.toHaveBeenCalled();
    }
  });

  it("drops a stored dashboard link that leaves the workspace dashboard instead of rendering it", () => {
    const card = presentProposalCard(storedProposal({
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      targetRef: {},
      versionToken: "create",
      payload: { name: "Alert", summary: "Alert.", presentation: { label: "usage alerts", dashboardPath: "https://elsewhere.example" }, change: { threshold: 1 } },
    }));

    expect(card).not.toHaveProperty("presentation");
  });

  it("states a removal the adapter drafted, so the card asks for the irreversible confirmation", async () => {
    const state = createAlertThresholdState();
    const contribution = createAlertThresholdContribution(state, {
      adapter: {
        async draft() {
          return { targetRef: { alertId: "alert-1" }, change: { remove: true }, versionToken: "v1", targetLabel: "Alert at 500 answers", summary: "Remove the alert.", presentation: ALERT_THRESHOLD_PRESENTATION, removesTarget: true };
        },
      },
    });
    const createProposal = vi.fn(async (input: Record<string, unknown>) => storedProposal(input));
    const [toolContribution] = createContributedProposalToolContributions(resolveCopilotProposalContributions([contribution]).contributions, {
      proposalRepository: { createProposal },
      auditService: { record: vi.fn(async () => undefined) },
    });

    const output = await toolContribution.descriptors[0].createTool(context).invoke({ threshold: 1 }, {} as never);

    expect(output).toMatchObject({ removal: true });
    expect(presentProposalCard(await createProposal.mock.results[0].value)).toMatchObject({ removal: true });
  });

  it("drops a stored dot-segment link instead of rendering it", () => {
    for (const dashboardPath of ["/../../login", "/%2e%2e/%2E%2E/login", "/./../w/other/agents"]) {
      const card = presentProposalCard(storedProposal({
        targetType: ALERT_THRESHOLD_TARGET_TYPE,
        targetRef: {},
        versionToken: "create",
        payload: { name: "Alert", summary: "Alert.", presentation: { label: "usage alerts", dashboardPath }, change: { threshold: 1 } },
      }));
      expect(card).not.toHaveProperty("presentation");
    }
  });

  it("keeps a contributed detail reference inside what proposal_detail publishes", async () => {
    const state = createAlertThresholdState();
    const [adapter] = resolveCopilotProposalContributions([createAlertThresholdContribution(state, {
      adapter: { proposalDetailTargetRef: () => ({ alertName: "x".repeat(400), enabled: true, owner: null, threshold: 500 as never, nested: {} as never }) },
    })]).adapters;
    const reference = adapter.proposalDetailTargetRef?.({}) ?? {};

    expect(reference).toEqual({ alertName: "x".repeat(300), enabled: true, owner: null });
    const detail = createProposalDetailTool({
      getProposalDetail: async () => ({
        proposalId: PROPOSAL_ID,
        targetType: ALERT_THRESHOLD_TARGET_TYPE,
        target: { agentId: null, directiveId: null, routineId: null, skillId: null, documentId: null, settingKey: null, label: "Alert", reference },
        summary: "Alert.",
        draftedChange: { threshold: 500 },
        status: "pending",
        createdAt: new Date("2026-11-11T10:00:00.000Z"),
        decidedAt: null,
        failureReason: null,
        reviewedOperation: false,
      }),
    }, resolveCopilotProposalContributions([createAlertThresholdContribution(createAlertThresholdState())]).targetTypes);
    await expect(detail.createTool(context).invoke({ proposalId: PROPOSAL_ID }, {} as never)).resolves.toMatchObject({ target: { reference } });
  });

  it("hands the contributed adapter its own change, never Ray's card fields", async () => {
    const { descriptor, created, resolved, state } = contributedTool();
    await descriptor.createTool(context).invoke({ threshold: 500 }, {} as never);
    const proposal = created[0];
    const [adapter] = resolved.adapters;

    await expect(adapter.preview("workspace-1", proposal.targetRef, proposal.payload)).resolves.toEqual({
      targetLabel: "Alert at 500 answers",
      current: null,
      proposed: { threshold: 500 },
    });
    await expect(adapter.applyIfVersionMatches("workspace-1", proposal.targetRef, proposal.payload, proposal.versionToken, { surface: "dashboard", accountId: "account-1" }))
      .resolves.toMatchObject({ outcome: "applied" });
    expect(adapter.canRetryAfterInterruptedApply?.(proposal.targetRef, proposal.payload)).toBe(false);
    expect(state.changesSeen).toEqual([{ threshold: 500 }, { threshold: 500 }]);
  });

  it("reads back through proposal_detail on a deployment that knows its target type", async () => {
    const detail = createProposalDetailTool({
      getProposalDetail: async () => ({
        proposalId: PROPOSAL_ID,
        targetType: ALERT_THRESHOLD_TARGET_TYPE,
        target: { agentId: null, directiveId: null, routineId: null, skillId: null, documentId: null, settingKey: null, label: "Alert at 500 answers", reference: {} },
        summary: "Alert the workspace once it uses 500 answers this month.",
        draftedChange: { threshold: 500 },
        status: "pending",
        createdAt: new Date("2026-11-11T10:00:00.000Z"),
        decidedAt: null,
        failureReason: null,
        reviewedOperation: false,
      }),
    }, resolveCopilotProposalContributions([createAlertThresholdContribution(createAlertThresholdState())]).targetTypes);

    await expect(detail.createTool(context).invoke({ proposalId: PROPOSAL_ID }, {} as never)).resolves.toMatchObject({
      proposalId: PROPOSAL_ID,
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
    });
  });
});
