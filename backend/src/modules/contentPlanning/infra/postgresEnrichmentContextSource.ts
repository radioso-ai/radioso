import type { JsonValue } from "../../../shared/infra/kysely/schema.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { ContentPlanEnrichmentClaim } from "../services/enrichmentProcessor.js";
import type {
  ContentPlanEnrichmentTopicContext,
  ContentPlanEnrichmentTopicContextSourcePort,
} from "../services/enrichmentContextService.js";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

type TopicRow = {
  workspace_id: string;
  generation_id: string;
  id: string;
  revision: number;
  lifecycle: ContentPlanEnrichmentTopicContext["lifecycle"];
  embedding_space_id: string;
  centroid: string;
  representative_observation_ids: string[];
};

export class PostgresContentPlanEnrichmentContextSource
implements ContentPlanEnrichmentTopicContextSourcePort {
  private readonly clock: () => Date;

  constructor(private readonly db: Db, clock?: () => Date) {
    this.clock = clock ?? (() => new Date());
  }

  async load(claim: ContentPlanEnrichmentClaim): Promise<ContentPlanEnrichmentTopicContext | null> {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("content_plan_enrichment_context_time_invalid");
    }
    const topic = await this.db
      .selectFrom("content_plan_topics")
      .select([
        "workspace_id",
        "generation_id",
        "id",
        "revision",
        "lifecycle",
        "embedding_space_id",
        "centroid",
        "representative_observation_ids",
      ])
      .where("workspace_id", "=", claim.workspaceId)
      .where("generation_id", "=", claim.generationId)
      .where("id", "=", claim.topicId)
      .executeTakeFirst();
    if (!topic) return null;

    const members = await this.db
      .selectFrom("content_plan_topic_memberships as membership")
      .innerJoin("content_plan_observations as observation", (join) => join
        .onRef("observation.workspace_id", "=", "membership.workspace_id")
        .onRef("observation.id", "=", "membership.observation_id"))
      .innerJoin("messages as assistant_message", (join) => join
        .onRef("assistant_message.workspace_id", "=", "observation.workspace_id")
        .onRef("assistant_message.id", "=", "observation.source_assistant_message_id"))
      .select([
        "observation.id as observation_id",
        "observation.source_assistant_message_id as assistant_message_id",
        "observation.conversation_id",
        "observation.observed_at",
        "assistant_message.metadata_json as assistant_metadata",
      ])
      .where("membership.workspace_id", "=", claim.workspaceId)
      .where("membership.generation_id", "=", claim.generationId)
      .where("membership.topic_id", "=", claim.topicId)
      .where("observation.observation_state", "=", "ready")
      .where("observation.observed_at", ">=", new Date(now.getTime() - WINDOW_MS))
      .where("observation.observed_at", "<", now)
      .orderBy("observation.observed_at", "asc")
      .orderBy("observation.id", "asc")
      .execute();

    const row = topic as TopicRow;
    return {
      workspaceId: row.workspace_id,
      generationId: row.generation_id,
      topicId: row.id,
      topicRevision: Number(row.revision),
      lifecycle: row.lifecycle,
      embeddingSpaceId: row.embedding_space_id,
      centroid: parsePgVector(row.centroid),
      representativeObservationIds: row.representative_observation_ids,
      members: members.map((member) => ({
        observationId: member.observation_id,
        assistantMessageId: member.assistant_message_id,
        conversationId: member.conversation_id,
        observedAt: new Date(member.observed_at).toISOString(),
        assistantMetadata: asObject(member.assistant_metadata),
      })),
    };
  }
}

const parsePgVector = (value: string): number[] => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Stored content planning centroid has an invalid representation");
  }
  const values = trimmed.slice(1, -1).split(",").map(Number);
  if (values.length === 0 || values.some((dimension) => !Number.isFinite(dimension))) {
    throw new Error("Stored content planning centroid has invalid dimensions");
  }
  return values;
};

const asObject = (value: JsonValue | null): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
