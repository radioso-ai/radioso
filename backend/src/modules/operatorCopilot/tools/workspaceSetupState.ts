import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";

/** The setup facts Ray reads: outcomes the server observed, never a count of what the workspace holds. */
export interface CopilotWorkspaceSetupSignals {
  hasReadyDocuments: boolean;
  hasCompletedChat: boolean;
  setup: {
    purpose: string | null; dismissed: boolean; skippedSteps: readonly string[];
    shouldShowFirstRun: boolean; hasDirectivesOrRoutines: boolean; hasNotifyDestination: boolean;
    hasNotifyDeliveryConfirmed: boolean; hasCredential: boolean;
  };
}

/**
 * Narrow on purpose: the tool, the per-turn context, and the empty state all read through it, and
 * the context reads it on every Ray turn, so an implementation answers with existence checks
 * rather than the counts the workspace summary endpoint reports.
 */
export interface CopilotWorkspaceSetupStatePort {
  getSetupSignals(workspaceId: string): Promise<CopilotWorkspaceSetupSignals>;
}

/** The permission the tool and the setup context Ray receives on every turn are both held to. */
export const workspaceSetupStatePermissions = ["workspace.summary.read"] as const;

const outputSchema = z.object({
  purpose: z.string().nullable(), dismissed: z.boolean(), skippedSteps: z.array(z.string()),
  shouldShowFirstRun: z.boolean(), documentsReady: z.boolean(), firstConversationHappened: z.boolean(),
  directivesOrRoutinesExist: z.boolean(), notifyDestinationConfigured: z.boolean(), notifyDeliveryConfirmed: z.boolean(), credentialExists: z.boolean(),
}).strict();

const description = "Read the workspace setup checklist. Each checklist result reports an observed outcome, not whether someone visited a page. While setup is open, a dashboard Ray turn already receives this state as trusted context, so it calls this tool only to re-check after the operator says they changed something and asks it to look again. Any other client calls it to learn what still needs configuring.";

export const createWorkspaceSetupStateCopilotTools = (deps: { workspaceSetupState: CopilotWorkspaceSetupStatePort }): ReadonlyArray<CopilotToolDescriptor> => [{
  name: "workspace_setup_state", shape: "read", verificationCost: () => 0, uiLabel: "Reading workspace setup state", contributingModule: "workspace", dashboardSubject: { type: "workspace_settings" }, requiredPermissions: workspaceSetupStatePermissions,
  description, inputSchema: z.object({}).strict(), outputSchema,
  createTool: (context) => ({ name: "workspace_setup_state", description, inputSchema: z.object({}).strict(), outputSchema, invoke: async () => {
    const summary = await deps.workspaceSetupState.getSetupSignals(context.workspaceId);
    return {
      ...summary.setup,
      documentsReady: summary.hasReadyDocuments,
      firstConversationHappened: summary.hasCompletedChat,
      directivesOrRoutinesExist: summary.setup.hasDirectivesOrRoutines,
      notifyDestinationConfigured: summary.setup.hasNotifyDestination,
      notifyDeliveryConfirmed: summary.setup.hasNotifyDeliveryConfirmed,
      credentialExists: summary.setup.hasCredential,
    };
  } }),
}];
