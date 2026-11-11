import { describe, expect, it, vi } from "vitest";

import { buildCopilotSetupStepLink } from "../../../src/modules/operatorCopilot/dashboardLinks.js";
import {
  WorkspaceSetupContext,
  deriveWorkspaceSetupGuidance,
} from "../../../src/modules/operatorCopilot/context/workspaceSetup.js";
import {
  collectCopilotContext,
  renderCopilotContextBlocks,
} from "../../../src/modules/operatorCopilot/context/contributor.js";
import type { CopilotWorkspaceSetupStatePort } from "../../../src/modules/operatorCopilot/tools/workspaceSetupState.js";

type Summary = Awaited<ReturnType<CopilotWorkspaceSetupStatePort["getSetupSignals"]>>;

/** A workspace where nothing has happened yet: the state Ray's empty state must be constructive about. */
const freshSummary = (overrides: Partial<Omit<Summary, "setup">> & { setup?: Partial<Summary["setup"]> } = {}): Summary => ({
  hasReadyDocuments: false,
  hasCompletedChat: false,
  ...overrides,
  setup: {
    purpose: null,
    dismissed: false,
    skippedSteps: [],
    shouldShowFirstRun: true,
    hasDirectivesOrRoutines: false,
    hasNotifyDestination: false,
    hasNotifyDeliveryConfirmed: false,
    hasCredential: false,
    ...overrides.setup,
  },
});

const completeSummary = (): Summary => freshSummary({
  hasReadyDocuments: true,
  hasCompletedChat: true,
  setup: {
    purpose: "Answer product questions",
    shouldShowFirstRun: false,
    hasDirectivesOrRoutines: true,
    hasNotifyDestination: true,
    hasNotifyDeliveryConfirmed: true,
    hasCredential: true,
  },
});

describe("setup step links", () => {
  it("points each completable step at the dashboard surface that completes it", () => {
    expect(buildCopilotSetupStepLink("acme", "documents")).toBe("/w/acme/knowledge");
    expect(buildCopilotSetupStepLink("acme", "conversation")).toBe("/w/acme/agents");
    expect(buildCopilotSetupStepLink("acme", "directives_or_routines")).toBe("/w/acme/agents?tab=behavior&anchor=assistant-directives");
    expect(buildCopilotSetupStepLink("acme", "notify_destination")).toBe("/w/acme/settings?anchor=webhook-destinations");
    expect(buildCopilotSetupStepLink("acme", "credential")).toBe("/w/acme/settings?tab=api-access");
  });

  it("has no link for a step no dashboard surface completes", () => {
    expect(buildCopilotSetupStepLink("acme", "purpose")).toBeNull();
  });

  it("encodes the workspace key like every other handoff link", () => {
    expect(buildCopilotSetupStepLink("a b", "documents")).toBe("/w/a%20b/knowledge");
  });
});

describe("workspace setup guidance", () => {
  it("names the next incomplete steps in flow order on a fresh workspace", () => {
    const guidance = deriveWorkspaceSetupGuidance(freshSummary());
    expect(guidance.phase).toBe("setup");
    expect(guidance.firstConversationHappened).toBe(false);
    expect(guidance.nextSteps).toEqual(["documents", "conversation", "directives_or_routines"]);
    expect(guidance.steps.find((entry) => entry.step === "documents")).toEqual({ step: "documents", status: "todo" });
  });

  it("never offers a step the state reports as done", () => {
    const guidance = deriveWorkspaceSetupGuidance(freshSummary({ hasReadyDocuments: true }));
    expect(guidance.steps.find((entry) => entry.step === "documents")?.status).toBe("done");
    expect(guidance.nextSteps).toEqual(["conversation", "directives_or_routines", "notify_destination"]);
    expect(guidance.nextSteps).not.toContain("documents");
  });

  it("never offers a step the operator skipped", () => {
    const guidance = deriveWorkspaceSetupGuidance(freshSummary({
      hasReadyDocuments: true,
      setup: { skippedSteps: ["conversation", "directives_or_routines"] },
    }));
    expect(guidance.steps.find((entry) => entry.step === "conversation")?.status).toBe("skipped");
    expect(guidance.nextSteps).toEqual(["notify_destination", "credential"]);
  });

  it("counts a step as done when its outcome exists even if the operator also skipped it", () => {
    const guidance = deriveWorkspaceSetupGuidance(freshSummary({ hasReadyDocuments: true, setup: { skippedSteps: ["documents"] } }));
    expect(guidance.steps.find((entry) => entry.step === "documents")?.status).toBe("done");
  });

  it("holds the handoff step open until delivery is confirmed, not merely configured", () => {
    const guidance = deriveWorkspaceSetupGuidance(freshSummary({
      hasReadyDocuments: true,
      hasCompletedChat: true,
      setup: { hasDirectivesOrRoutines: true, hasNotifyDestination: true, hasNotifyDeliveryConfirmed: false },
    }));
    expect(guidance.steps.find((entry) => entry.step === "notify_destination")?.status).toBe("todo");
    expect(guidance.nextSteps).toEqual(["notify_destination", "credential"]);
  });

  it("opens the open-ended phase once every completable step is done or skipped", () => {
    const skippedTail = deriveWorkspaceSetupGuidance(freshSummary({
      hasReadyDocuments: true,
      hasCompletedChat: true,
      setup: { hasDirectivesOrRoutines: true, skippedSteps: ["notify_destination", "credential"] },
    }));
    expect(skippedTail.phase).toBe("open");
    expect(skippedTail.nextSteps).toEqual([]);

    const complete = deriveWorkspaceSetupGuidance(completeSummary());
    expect(complete.phase).toBe("open");
    expect(complete.firstConversationHappened).toBe(true);
  });

  it("opens the open-ended phase when the operator dismissed setup, without inventing a first conversation", () => {
    const guidance = deriveWorkspaceSetupGuidance(freshSummary({ setup: { dismissed: true } }));
    expect(guidance.phase).toBe("open");
    expect(guidance.nextSteps).toEqual([]);
    expect(guidance.firstConversationHappened).toBe(false);
  });

  it("does not hold setup open for a step no dashboard surface can complete", () => {
    const guidance = deriveWorkspaceSetupGuidance({
      ...completeSummary(),
      setup: { ...completeSummary().setup, purpose: null },
    });
    expect(guidance.steps.find((entry) => entry.step === "purpose")?.status).toBe("todo");
    expect(guidance.phase).toBe("open");
    expect(guidance.nextSteps).toEqual([]);
  });
});

describe("workspace setup context contributor", () => {
  const port = (summary: Summary): CopilotWorkspaceSetupStatePort & { getSetupSignals: ReturnType<typeof vi.fn> } => ({
    getSetupSignals: vi.fn(async () => summary),
  });
  const scope = (permissions: string[] = ["workspace.summary.read"]) => ({
    workspaceId: "workspace-1",
    workspaceKey: "acme",
    permissions: new Set(permissions),
  });

  it("contributes the fresh-workspace state with a deep link for every next step", async () => {
    const context = new WorkspaceSetupContext({ workspaceSetupState: port(freshSummary()) });
    const block = await context.contribute(scope());
    expect(block).toEqual({
      id: "workspace_setup",
      data: {
        phase: "setup",
        firstConversationHappened: false,
        steps: expect.arrayContaining([{ step: "documents", status: "todo" }]),
        nextSteps: [
          { step: "documents", dashboardUrl: "/w/acme/knowledge" },
          { step: "conversation", dashboardUrl: "/w/acme/agents" },
          { step: "directives_or_routines", dashboardUrl: "/w/acme/agents?tab=behavior&anchor=assistant-directives" },
        ],
      },
    });
  });

  it("contributes nothing once setup is complete and a conversation has happened", async () => {
    const context = new WorkspaceSetupContext({ workspaceSetupState: port(completeSummary()) });
    expect(await context.contribute(scope())).toBeNull();
  });

  it("still tells Ray no conversation has happened after setup was dismissed", async () => {
    const context = new WorkspaceSetupContext({ workspaceSetupState: port(freshSummary({ setup: { dismissed: true } })) });
    const block = await context.contribute(scope());
    expect(block?.data).toMatchObject({ phase: "open", firstConversationHappened: false, nextSteps: [] });
  });

  it("reads nothing for an operator who cannot read the workspace summary", async () => {
    const setupPort = port(freshSummary());
    const context = new WorkspaceSetupContext({ workspaceSetupState: setupPort });
    expect(await context.contribute(scope(["workspace.agents.read"]))).toBeNull();
    expect(await context.guidance(scope(["workspace.agents.read"]))).toBeNull();
    expect(setupPort.getSetupSignals).not.toHaveBeenCalled();
  });
});

describe("copilot context collection", () => {
  const scope = { workspaceId: "workspace-1", workspaceKey: "acme", permissions: new Set<string>() };

  it("keeps the blocks of the contributors that answered and reports the ones that failed", async () => {
    const onFailure = vi.fn();
    const blocks = await collectCopilotContext([
      { id: "broken", contribute: async () => { throw new Error("database unavailable"); } },
      { id: "quiet", contribute: async () => null },
      { id: "good", contribute: async () => ({ id: "good", data: { ok: true } }) },
    ], scope, onFailure);
    expect(blocks).toEqual([{ id: "good", data: { ok: true } }]);
    expect(onFailure).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("renders nothing when no contributor has anything to say", () => {
    expect(renderCopilotContextBlocks([])).toBe("");
  });

  it("renders the blocks as one trusted-data object keyed by block id", () => {
    const rendered = renderCopilotContextBlocks([{ id: "workspace_setup", data: { phase: "setup" } }]);
    expect(rendered).toContain("trusted runtime data");
    expect(rendered.trim().endsWith(JSON.stringify({ workspace_setup: { phase: "setup" } }))).toBe(true);
  });
});
