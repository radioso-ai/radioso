import type { ManagedModelSelection } from "../../domain/managedModelPolicy.js";
import type { LlmCapabilityResolver } from "./capabilityResolver.js";
import { workspaceLlmCapabilities, type WorkspaceLlmCapability } from "../../../modules/settings/contracts/llmCapability.js";

type WorkspaceManagedLlmModels = Record<WorkspaceLlmCapability, ManagedModelSelection | null>;

type WorkspaceLlmSelectionPort = Pick<LlmCapabilityResolver, "resolveSelection">;

/**
 * What each text capability runs on when the plan decides instead of the
 * workspace. `null` means the workspace's own preference (or the deployment
 * default) applies. Read-only: it asks the resolver the same question a call
 * would, without touching keys.
 */
export const resolveWorkspaceManagedLlmModels = async (
  resolver: WorkspaceLlmSelectionPort,
  workspaceId: string,
): Promise<WorkspaceManagedLlmModels> => {
  const entries = await Promise.all(
    workspaceLlmCapabilities.map(async (capability) => {
      const selection = await resolver.resolveSelection(capability, { workspaceId });
      const managed: ManagedModelSelection | null =
        selection.resolvedBy === "managed_plan"
          ? { provider: selection.provider, model: selection.model }
          : null;
      return [capability, managed] as const;
    }),
  );
  return Object.fromEntries(entries) as WorkspaceManagedLlmModels;
};
