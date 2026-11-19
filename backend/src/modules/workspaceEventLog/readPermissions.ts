import type { AccountPermission } from "../account/public.js";
import { WORKSPACE_EVENT_TYPES, type WorkspaceEventType } from "../../shared/domain/workspaceEventLog.js";

/** The permission that lists the log at all. Each type then needs what reads its subject elsewhere. */
export const WORKSPACE_EVENTS_READ_PERMISSION = "workspace.events.read" as const satisfies AccountPermission;

/**
 * What a caller needs to read each type, matched to who may see the same facts elsewhere, so the
 * log never shows more to a role than it may see: conversation events need history's read, and a
 * pending decision also the takeover permission the Inbox's decisions need. A pending decision is a
 * notification: the decision list and its resolution are dashboard-session routes, so an API token
 * that reads `decision.pending` can neither list nor resolve the decision over the API, and a
 * teammate acts on it in the Inbox.
 */
const READ_PERMISSIONS: Readonly<Record<WorkspaceEventType, readonly AccountPermission[]>> = {
  "conversation.started": ["workspace.history.read"],
  "contact_request.created": ["workspace.history.read"],
  "handoff.requested": ["workspace.history.read"],
  "routine.completed": ["workspace.history.read"],
  "decision.pending": ["workspace.history.read", "workspace.conversation.takeover"],
};

/**
 * Everything a caller needs to read `types` from the log: the log's own read permission and what
 * each type adds. A subscription's creator must hold all of it at every push.
 */
export const permissionsToReadEventTypes = (types: readonly WorkspaceEventType[]): AccountPermission[] =>
  [...new Set<AccountPermission>([WORKSPACE_EVENTS_READ_PERMISSION, ...types.flatMap((type) => READ_PERMISSIONS[type])])];

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
