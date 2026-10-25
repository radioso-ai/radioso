import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { VoiceRecordingScope } from "../domain.js";

/**
 * The `voice_sessions` rows in an erasure's scope: a workspace's conversations (one array
 * parameter, however many), the calls the website embed started for a visitor's key, or the whole
 * workspace. Shared by the hand-off's lock and the backlog's copy, so both read the same rows.
 */
export const voiceSessionsInScope = (db: Db, scope: VoiceRecordingScope) => {
  let query = db.selectFrom("voice_sessions as s").where("s.workspace_id", "=", scope.workspaceId);
  if (scope.kind === "conversations") {
    query = query.where((eb) => anyOf(eb.ref("s.conversation_id"), scope.conversationIds, "uuid[]"));
  }
  if (scope.kind === "visitor_key") query = query.where("s.started_visitor_key", "=", scope.visitorKey);
  return query;
};

/** An erasure scope that names no conversation reaches no session. */
export const isEmptyScope = (scope: VoiceRecordingScope): boolean =>
  scope.kind === "conversations" && scope.conversationIds.length === 0;
