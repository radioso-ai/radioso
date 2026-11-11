import type { AgenticCapabilityRunner } from "../../shared/agent-runtime/index.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import {
  CopilotEmptyStateService,
  WorkspaceSetupContext,
  type CopilotContextContributor,
  type CopilotWorkspaceRouteKeyResolver,
} from "../../modules/operatorCopilot/public.js";
import type { CopilotWorkspaceSetupStatePort } from "../../modules/operatorCopilot/tools/workspaceSetupState.js";

/**
 * Assembles what Ray learns about the workspace without being asked: the context contributors every
 * turn reads, and the service that writes the empty panel's greeting from the same state. One
 * setup-state port feeds all of them, the same one the `workspace_setup_state` tool reads, so the
 * tool, the turn context, and the empty state cannot disagree about what is done.
 */
export const createCopilotContext = (deps: {
  readonly workspaceSetupState: CopilotWorkspaceSetupStatePort;
  readonly capabilityRunner: Pick<AgenticCapabilityRunner, "runStreaming">;
  readonly usageLimitPolicy: Pick<UsageLimitPolicy, "reserveAnswer">;
  readonly prompt: string;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly logger: { warn(fields: Record<string, unknown>, message: string): void };
}): { readonly contributors: ReadonlyArray<CopilotContextContributor>; readonly emptyState: CopilotEmptyStateService } => {
  const setup = new WorkspaceSetupContext({ workspaceSetupState: deps.workspaceSetupState });
  return {
    contributors: [setup],
    emptyState: new CopilotEmptyStateService({
      capabilityRunner: deps.capabilityRunner,
      usageLimitPolicy: deps.usageLimitPolicy,
      prompt: deps.prompt,
      workspaceRouteKeyResolver: deps.workspaceRouteKeyResolver,
      setup,
      logger: deps.logger,
    }),
  };
};
