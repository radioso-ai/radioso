import type { AccountPermission } from "../account/public.js";
import type { CopilotToolInvocationContext } from "./contracts.js";

/** Thrown inside a descriptor when a just-in-time authorization check denies its protected work. */
export class CopilotToolAuthorizationError extends Error {
  constructor() {
    super("Copilot tool authorization was revoked");
  }
}

/**
 * Turn-start permissions select the catalog only. Every descriptor-owned read
 * and proposal write must ask the authorization owner again at the boundary.
 */
export const hasCurrentCopilotPermissions = (
  context: CopilotToolInvocationContext,
  requiredPermissions: readonly AccountPermission[],
): Promise<boolean> => context.currentAuthorization.hasAllPermissions({
  workspaceId: context.workspaceId,
  accountId: context.accountId,
  operatorUserId: context.operatorUserId,
  requiredPermissions,
});

export const requireCurrentCopilotPermissions = async (
  context: CopilotToolInvocationContext,
  requiredPermissions: readonly AccountPermission[],
): Promise<void> => {
  if (await hasCurrentCopilotPermissions(context, requiredPermissions)) return;
  throw new CopilotToolAuthorizationError();
};
