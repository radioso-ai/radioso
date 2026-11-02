import type { WorkspaceTimeZoneReader } from "../../retrieval/public.js";
import {
  canonicalTimeZone,
  resolveReferenceTimeZone,
  type ReferenceTimeZone,
} from "../../../shared/domain/referenceTimeZone.js";

/**
 * The zone a chat turn reads "today" in, resolved once before planning so the planner, the
 * rewrite, retrieval and the answer all share it. A valid visitor zone decides on its own, so
 * the workspace's zone is read only when the visitor's client reports none.
 */
export const resolveTurnReferenceTimeZone = async (
  workspaceTimeZones: WorkspaceTimeZoneReader | undefined,
  input: { workspaceId: string; visitorTimeZone?: string | null },
): Promise<ReferenceTimeZone> => {
  const workspaceTimeZone = canonicalTimeZone(input.visitorTimeZone)
    ? null
    : await workspaceTimeZones?.readWorkspaceTimeZone(input.workspaceId);
  return resolveReferenceTimeZone({ visitorTimeZone: input.visitorTimeZone, workspaceTimeZone });
};
