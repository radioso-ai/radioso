import type { ConversationTraceStage } from "@radioso/conversation-contract";

import type { WorkspaceTimeZoneReader } from "../../retrieval/public.js";
import {
  canonicalTimeZone,
  resolveReferenceTimeZone,
  type ReferenceTimeZone,
} from "../../../shared/domain/referenceTimeZone.js";

/**
 * The zone a chat turn reads "today" in, resolved once before planning so the planner, the
 * rewrite, retrieval and the answer all share it. A valid visitor zone, or one the conversation
 * recorded, decides on its own, so the workspace's zone is read only when neither names one.
 */
export const resolveTurnReferenceTimeZone = async (
  workspaceTimeZones: WorkspaceTimeZoneReader | undefined,
  input: { workspaceId: string; visitorTimeZone?: string | null; conversationTimeZone?: string | null },
): Promise<ReferenceTimeZone> => {
  const decidedWithoutWorkspace = canonicalTimeZone(input.visitorTimeZone) ?? canonicalTimeZone(input.conversationTimeZone);
  const workspaceTimeZone = decidedWithoutWorkspace
    ? null
    : await workspaceTimeZones?.readWorkspaceTimeZone(input.workspaceId);
  return resolveReferenceTimeZone({
    visitorTimeZone: input.visitorTimeZone,
    conversationTimeZone: input.conversationTimeZone,
    workspaceTimeZone,
  });
};

/**
 * The key a visitor's message records the zone their client reported under. A turn with no live
 * visitor request, such as a routine resumed by an approval click, reads it back as the zone the
 * conversation last ran in.
 */
const VISITOR_TIME_ZONE_METADATA_KEY = "visitorTimeZone";

/**
 * The metadata that records a turn's zone on the visitor's message: only a zone the visitor's
 * client reported, since the workspace's setting is read live when it is needed and UTC is not
 * a fact about the conversation.
 */
export const visitorTimeZoneTurnMetadata = (zone: ReferenceTimeZone): Record<string, string> =>
  zone.source === "visitor" ? { [VISITOR_TIME_ZONE_METADATA_KEY]: zone.timeZone } : {};

/** The visitor zone a message's metadata records, or null when it records none. */
export const recordedVisitorTimeZone = (metadata: unknown): string | null => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  return canonicalTimeZone((metadata as Record<string, unknown>)[VISITOR_TIME_ZONE_METADATA_KEY]);
};

/**
 * A trace stage for a turn that has no retrieval run to carry the zone's source: it names which
 * input decided the zone (`visitor`, `conversation`, `workspace`, or `default` for UTC), never the
 * zone itself, so a support reader can tell a turn that read UTC from one that read a local day.
 */
export const referenceTimeZoneTraceStage = (zone: ReferenceTimeZone, startedAt: string): ConversationTraceStage => ({
  id: "reference-time-zone",
  kind: "context",
  status: "applied",
  startedAt,
  inputs: { timeZoneSource: zone.source },
});
