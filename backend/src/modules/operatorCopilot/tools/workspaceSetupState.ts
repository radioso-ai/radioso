import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";

export interface CopilotWorkspaceSetupStatePort {
  getSummary(workspaceId: string): Promise<{ hasReadyDocuments: boolean; hasCompletedChat: boolean; setup: {
    purpose: string | null; dismissed: boolean; notifyReceiptConfirmed: boolean; skippedSteps: readonly string[];
    shouldShowFirstRun: boolean; hasDirectivesOrRoutines: boolean; hasNotifyDestination: boolean;
    hasNotifyDeliveryConfirmed: boolean; hasCredential: boolean;
  } }>;
}

const outputSchema = z.object({
  purpose: z.string().nullable(), dismissed: z.boolean(), notifyReceiptConfirmed: z.boolean(), skippedSteps: z.array(z.string()),
  shouldShowFirstRun: z.boolean(), documentsReady: z.boolean(), firstConversationHappened: z.boolean(),
  directivesOrRoutinesExist: z.boolean(), notifyDestinationConfigured: z.boolean(), notifyDeliveryConfirmed: z.boolean(), credentialExists: z.boolean(),
}).strict();

const description = "Read the workspace setup checklist. Each checklist result reports an observed outcome, not whether someone visited a page. Use this when an operator asks what still needs configuring.";

export const createWorkspaceSetupStateCopilotTools = (deps: { workspaceSetupState: CopilotWorkspaceSetupStatePort }): ReadonlyArray<CopilotToolDescriptor> => [{
  name: "workspace_setup_state", shape: "read", verificationCost: () => 0, uiLabel: "Reading workspace setup state", contributingModule: "workspace", dashboardSubject: { type: "workspace_settings" }, requiredPermissions: ["workspace.summary.read"],
  description, inputSchema: z.object({}).strict(), outputSchema,
  createTool: (context) => ({ name: "workspace_setup_state", description, inputSchema: z.object({}).strict(), outputSchema, invoke: async () => {
    const summary = await deps.workspaceSetupState.getSummary(context.workspaceId);
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
