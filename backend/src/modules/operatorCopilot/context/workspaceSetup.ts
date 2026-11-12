import { workspaceSetupSteps, type WorkspaceSetupStep } from "../../../db/repositories/workspaceSetupStateRepository.js";
import { buildCopilotSetupStepLink, isLinkedCopilotSetupStep } from "../dashboardLinks.js";
import {
  workspaceSetupStatePermissions,
  type CopilotWorkspaceSetupStatePort,
  type CopilotWorkspaceSetupSignals,
} from "../tools/workspaceSetupState.js";
import type { CopilotContextBlock, CopilotContextContributor, CopilotContextScope } from "./contributor.js";

type WorkspaceSetupStepStatus = "done" | "skipped" | "todo";

/**
 * What Ray needs to know about onboarding, derived from the server-owned setup state and nothing
 * else. `phase` is `setup` while an operator can still complete a step from the dashboard and has
 * not dismissed setup; once it is `open`, Ray's suggestions move to the open-ended tail.
 */
export interface WorkspaceSetupGuidance {
  readonly phase: "setup" | "open";
  /** The only thing that licenses Ray to talk about what visitors asked or how the agent answered. */
  readonly firstConversationHappened: boolean;
  readonly steps: ReadonlyArray<{ readonly step: WorkspaceSetupStep; readonly status: WorkspaceSetupStepStatus }>;
  /** Incomplete steps with a dashboard surface that completes them, in flow order. */
  readonly nextSteps: ReadonlyArray<WorkspaceSetupStep>;
}

const NEXT_STEP_LIMIT = 3;

const stepOutcomeExists = (summary: CopilotWorkspaceSetupSignals, step: WorkspaceSetupStep): boolean => {
  switch (step) {
    case "purpose": return summary.setup.purpose !== null && summary.setup.purpose.trim().length > 0;
    case "documents": return summary.hasReadyDocuments;
    case "conversation": return summary.hasCompletedChat;
    case "directives_or_routines": return summary.setup.hasDirectivesOrRoutines;
    // A destination that has never received a delivery has not been proven; the step is the receipt.
    case "notify_destination": return summary.setup.hasNotifyDeliveryConfirmed;
    case "credential": return summary.setup.hasCredential;
  }
};

export const deriveWorkspaceSetupGuidance = (summary: CopilotWorkspaceSetupSignals): WorkspaceSetupGuidance => {
  const steps = workspaceSetupSteps.map((step) => ({
    step,
    // An outcome outranks a skip: a step the operator skipped and later completed is done.
    status: stepOutcomeExists(summary, step) ? "done" as const : summary.setup.skippedSteps.includes(step) ? "skipped" as const : "todo" as const,
  }));
  const completable = steps.filter((entry) => entry.status === "todo" && isLinkedCopilotSetupStep(entry.step)).map((entry) => entry.step);
  const phase = !summary.setup.dismissed && completable.length > 0 ? "setup" : "open";
  return {
    phase,
    firstConversationHappened: summary.hasCompletedChat,
    steps,
    nextSteps: phase === "setup" ? completable.slice(0, NEXT_STEP_LIMIT) : [],
  };
};

/** What the empty state asks of the setup context; a narrower port than the contributor it is. */
export interface CopilotSetupGuidancePort {
  /** Null for an operator the summary would be withheld from, matching the tool's own permission. */
  guidance(scope: Pick<CopilotContextScope, "workspaceId" | "permissions">): Promise<WorkspaceSetupGuidance | null>;
}

const WORKSPACE_SETUP_CONTEXT_ID = "workspace_setup";

/** The block Ray reads: the guidance plus, for each next step, where the operator completes it. */
export const workspaceSetupContextBlock = (guidance: WorkspaceSetupGuidance, workspaceKey: string): CopilotContextBlock | null => {
  // Once setup is over and a conversation has happened there is nothing left for Ray to steer.
  if (guidance.phase === "open" && guidance.firstConversationHappened) return null;
  return {
    id: WORKSPACE_SETUP_CONTEXT_ID,
    data: {
      phase: guidance.phase,
      firstConversationHappened: guidance.firstConversationHappened,
      steps: guidance.steps,
      nextSteps: guidance.nextSteps.map((step) => ({ step, dashboardUrl: buildCopilotSetupStepLink(workspaceKey, step) })),
    },
  };
};

/**
 * Feeds the workspace's setup state to Ray through the same port its `workspace_setup_state` tool
 * reads, so the tool, the per-turn context, and the empty state cannot disagree about what is done.
 */
export class WorkspaceSetupContext implements CopilotContextContributor, CopilotSetupGuidancePort {
  readonly id = WORKSPACE_SETUP_CONTEXT_ID;

  constructor(private readonly deps: { readonly workspaceSetupState: CopilotWorkspaceSetupStatePort }) {}

  async guidance(scope: Pick<CopilotContextScope, "workspaceId" | "permissions">): Promise<WorkspaceSetupGuidance | null> {
    if (!workspaceSetupStatePermissions.every((permission) => scope.permissions.has(permission))) return null;
    return deriveWorkspaceSetupGuidance(await this.deps.workspaceSetupState.getSetupSignals(scope.workspaceId));
  }

  async contribute(scope: CopilotContextScope): Promise<CopilotContextBlock | null> {
    const guidance = await this.guidance(scope);
    return guidance === null ? null : workspaceSetupContextBlock(guidance, scope.workspaceKey);
  }
}
