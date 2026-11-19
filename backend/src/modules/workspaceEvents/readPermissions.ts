import type { AccountPermission } from "../account/public.js";
import { WORKSPACE_EVENT_TYPES, type WorkspaceEventType } from "../../shared/domain/workspaceEvents.js";

/** The permission that lists the log at all. Each type then needs what reads its subject elsewhere. */
export const WORKSPACE_EVENTS_READ_PERMISSION = "workspace.events.read" as const satisfies AccountPermission;

/**
 * What a caller needs to read each type, matched to where the same facts are read elsewhere, so the
 * log never shows more than those reads do: conversation events need history's read, and a pending
 * decision also the takeover permission the decision list (`GET /api/v1/decisions`) needs.
 */
const READ_PERMISSIONS: Readonly<Record<WorkspaceEventType, readonly AccountPermission[]>> = {
  "conversation.started": ["workspace.history.read"],
  "contact_request.created": ["workspace.history.read"],
  "handoff.requested": ["workspace.history.read"],
  "routine.completed": ["workspace.history.read"],
  "decision.pending": ["workspace.history.read", "workspace.conversation.takeover"],
};

/** The types a caller may read, resolved once through however the edge checks its permissions. */
export const resolveReadableEventTypes = async (
  holdsPermission: (permission: AccountPermission) => Promise<boolean>,
): Promise<WorkspaceEventType[]> => {
  const permissions = [...new Set(Object.values(READ_PERMISSIONS).flat())];
  const held = new Set<AccountPermission>();
  for (const permission of permissions) {
    if (await holdsPermission(permission)) held.add(permission);
  }
  return WORKSPACE_EVENT_TYPES.filter((type) => READ_PERMISSIONS[type].every((permission) => held.has(permission)));
};
