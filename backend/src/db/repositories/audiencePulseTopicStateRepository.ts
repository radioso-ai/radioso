import type {
  AudiencePulseTopicDraftLink,
  AudiencePulseTopicState,
  AudiencePulseTopicStateStore,
  AudiencePulseTopicStateWrite,
} from "../../modules/audiencePulse/contracts.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/** Postgres adapter for operator state on Audience Pulse topics: one row per dismissal or draft link. */
export class AudiencePulseTopicStateRepository implements AudiencePulseTopicStateStore {
  constructor(private readonly db: Db) {}

  async readTopicStates(input: {
    workspaceId: string;
    topicIds: readonly string[];
  }): Promise<Map<string, AudiencePulseTopicState>> {
    const states = new Map<string, AudiencePulseTopicState>();
    if (input.topicIds.length === 0) return states;
    const topicIds = [...input.topicIds];
    const [dismissals, latestDrafts] = await Promise.all([
      this.db
        .selectFrom("audience_pulse_topic_dismissals")
        .select(["topic_id", "created_at"])
        .where("workspace_id", "=", input.workspaceId)
        .where("topic_id", "in", topicIds)
        .execute(),
      this.db
        .selectFrom("audience_pulse_topic_drafts")
        .distinctOn("topic_id")
        .select(["topic_id", "document_id", "created_at"])
        .where("workspace_id", "=", input.workspaceId)
        .where("topic_id", "in", topicIds)
        .orderBy("topic_id")
        .orderBy("created_at", "desc")
        .orderBy("document_id", "desc")
        .execute(),
    ]);
    const stateOf = (topicId: string): AudiencePulseTopicState => {
      const state = states.get(topicId) ?? { dismissedAt: null, latestDraft: null };
      states.set(topicId, state);
      return state;
    };
    for (const row of dismissals) stateOf(row.topic_id).dismissedAt = new Date(row.created_at);
    for (const row of latestDrafts) {
      stateOf(row.topic_id).latestDraft = { documentId: row.document_id, createdAt: new Date(row.created_at) };
    }
    return states;
  }

  async dismiss(input: { workspaceId: string; topicId: string; userId: string }): Promise<AudiencePulseTopicStateWrite> {
    if (!(await this.topicExists(input))) return "topic_not_found";
    const inserted = await this.db
      .insertInto("audience_pulse_topic_dismissals")
      .values({ workspace_id: input.workspaceId, topic_id: input.topicId, dismissed_by_user_id: input.userId })
      .onConflict((oc) => oc.columns(["workspace_id", "topic_id"]).doNothing())
      .returning("topic_id")
      .executeTakeFirst();
    return inserted ? "changed" : "unchanged";
  }

  async restore(input: { workspaceId: string; topicId: string }): Promise<AudiencePulseTopicStateWrite> {
    if (!(await this.topicExists(input))) return "topic_not_found";
    const result = await this.db
      .deleteFrom("audience_pulse_topic_dismissals")
      .where("workspace_id", "=", input.workspaceId)
      .where("topic_id", "=", input.topicId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0 ? "changed" : "unchanged";
  }

  async linkDraft(input: {
    workspaceId: string;
    topicId: string;
    documentId: string;
    userId: string;
  }): Promise<AudiencePulseTopicDraftLink> {
    if (!(await this.topicExists(input))) return "topic_not_found";
    const document = await this.db
      .selectFrom("documents")
      .select("id")
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .executeTakeFirst();
    if (!document) return "document_not_found";
    const inserted = await this.db
      .insertInto("audience_pulse_topic_drafts")
      .values({
        workspace_id: input.workspaceId,
        topic_id: input.topicId,
        document_id: input.documentId,
        created_by_user_id: input.userId,
      })
      .onConflict((oc) => oc.columns(["workspace_id", "topic_id", "document_id"]).doNothing())
      .returning("topic_id")
      .executeTakeFirst();
    return inserted ? "changed" : "unchanged";
  }

  private async topicExists(input: { workspaceId: string; topicId: string }): Promise<boolean> {
    const topic = await this.db
      .selectFrom("topics")
      .select("id")
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.topicId)
      .executeTakeFirst();
    return topic !== undefined;
  }
}
