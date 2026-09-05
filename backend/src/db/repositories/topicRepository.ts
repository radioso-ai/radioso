import { sql } from "kysely";

import type {
  ActiveTopicRecord,
  CreateTopicCensusRunInput,
  SaveTopicCensusRunInput,
  TopicCensusRunDissolvedTopic,
  TopicCensusRunDetail,
  TopicCensusRunTopicSummary,
  TopicMembershipInput,
  TopicRepositoryPort,
  TopicSaveInput,
  TopicTransitionKind,
  TopicTransitionInput,
} from "../../modules/audiencePulse/contracts/topicCensus.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

// topics.centroid is a typeless pgvector column (codegen maps it to `string`; see
// backend/scripts/generate-kysely-types.sh). Serialize/parse the pgvector text literal
// here so every other layer works with plain number[].
const serializeVector = (embedding: readonly number[]): string => `[${embedding.join(",")}]`;

const parseVector = (value: string): number[] => {
  const normalized = value.trim();
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    throw new Error("Stored topic centroid is not a pgvector literal");
  }
  if (normalized === "[]") {
    return [];
  }
  return normalized
    .slice(1, -1)
    .split(",")
    .map((part) => Number(part));
};

const BATCH_SIZE = 500;

const chunk = <T,>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

interface TopicCensusRunRow {
  id: string;
  workspace_id: string;
  window_start: Date;
  window_end: Date;
  question_count: number;
  unclassified_count: number;
  seed: string;
  params_json: unknown;
  created_at: Date;
}

export class TopicRepository implements TopicRepositoryPort {
  constructor(private readonly db: Db) {}

  /**
   * Runs `fn` atomically across all its batches. If `this.db` is already a
   * `Transaction` (the caller composing this call with others into one save, e.g.
   * `saveTopics` + `saveMemberships` + `saveTransitions`), reuses it directly — Kysely
   * does not support opening a nested transaction on a `Transaction` instance.
   */
  private async withTransaction<T>(fn: (trx: Db) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) {
      return fn(this.db);
    }
    return this.db.transaction().execute(fn);
  }

  private async requireRunWorkspaceId(runId: string, db: Db = this.db): Promise<string> {
    const row = await db
      .selectFrom("topic_census_runs")
      .select("workspace_id")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    return row.workspace_id;
  }

  private async assertTopicsBelongToWorkspace(
    db: Db,
    workspaceId: string,
    topicIds: readonly string[],
    options: { requireExisting?: boolean } = {},
  ): Promise<void> {
    const ids = [...new Set(topicIds)];
    if (ids.length === 0) {
      return;
    }
    const rows = await db
      .selectFrom("topics")
      .select(["id", "workspace_id"])
      .where("id", "in", ids)
      .execute();
    const matching = new Set(rows
      .filter((row) => row.workspace_id === workspaceId)
      .map((row) => row.id));
    if (rows.some((row) => row.workspace_id !== workspaceId)
      || (options.requireExisting && matching.size !== ids.length)) {
      throw new Error("topic_repository: topic id is missing or belongs to a different workspace");
    }
  }

  private async assertMessagesBelongToWorkspace(
    db: Db,
    workspaceId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) {
      return;
    }
    const rows = await db
      .selectFrom("messages")
      .select("id")
      .where("id", "in", ids)
      .where("workspace_id", "=", workspaceId)
      .execute();
    if (rows.length !== ids.length) {
      throw new Error("topic_repository: message id is missing or belongs to a different workspace");
    }
  }

  async saveRun(input: SaveTopicCensusRunInput): Promise<string> {
    return this.withTransaction(async (trx) => {
      const trxRepository = new TopicRepository(trx);
      const runId = await trxRepository.createRun(input.run);
      await trxRepository.saveTopics(runId, input.topics);
      await trxRepository.saveMemberships(runId, input.memberships);
      await trxRepository.saveTransitions(runId, input.transitions ?? []);
      await trxRepository.markDissolved(runId, input.dissolvedTopicIds ?? []);
      return runId;
    });
  }

  async createRun(input: CreateTopicCensusRunInput): Promise<string> {
    const row = await this.db
      .insertInto("topic_census_runs")
      .values({
        workspace_id: input.workspaceId,
        window_start: input.windowStart,
        window_end: input.windowEnd,
        question_count: input.questionCount,
        unclassified_count: input.unclassifiedCount,
        seed: input.seed,
        params_json: toJsonb(input.params),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async listActiveTopics(workspaceId: string): Promise<ActiveTopicRecord[]> {
    return this.listTopicsForMatching(workspaceId, { includeDissolved: false });
  }

  async listMatchableTopics(workspaceId: string): Promise<ActiveTopicRecord[]> {
    return this.listTopicsForMatching(workspaceId, { includeDissolved: true });
  }

  private async listTopicsForMatching(
    workspaceId: string,
    options: { includeDissolved: boolean },
  ): Promise<ActiveTopicRecord[]> {
    const rows = await this.db
      .selectFrom("topics")
      .select([
        "id",
        "workspace_id",
        "centroid",
        "radius",
        "title",
        "description",
        "created_run_id",
        "last_seen_run_id",
        "dissolved_at",
      ])
      .where("workspace_id", "=", workspaceId)
      .$if(!options.includeDissolved, (qb) => qb.where("dissolved_at", "is", null))
      .execute();
    if (rows.length === 0) {
      return [];
    }

    // Each topic's membership as of the run it last appeared in -- the exact set
    // identity matching needs as `priorTopics` for the next run (see the
    // `ActiveTopicRecord` doc). The join ties `run_id` to that specific topic's
    // `last_seen_run_id` rather than filtering both columns independently, since a
    // topic that has survived several runs has real membership rows at each of them
    // and only the most recent is still current.
    const memberRows = await this.db
      .selectFrom("topic_memberships")
      .innerJoin("topics", (join) =>
        join
          .onRef("topics.id", "=", "topic_memberships.topic_id")
          .onRef("topics.last_seen_run_id", "=", "topic_memberships.run_id"))
      .select(["topic_memberships.topic_id", "topic_memberships.message_id"])
      .where("topics.workspace_id", "=", workspaceId)
      .$if(!options.includeDissolved, (qb) => qb.where("topics.dissolved_at", "is", null))
      .execute();
    const memberIdsByTopic = new Map<string, string[]>();
    for (const memberRow of memberRows) {
      const bucket = memberIdsByTopic.get(memberRow.topic_id) ?? [];
      bucket.push(memberRow.message_id);
      memberIdsByTopic.set(memberRow.topic_id, bucket);
    }

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      centroid: parseVector(row.centroid),
      radius: row.radius,
      title: row.title,
      description: row.description,
      createdRunId: row.created_run_id,
      lastSeenRunId: row.last_seen_run_id,
      dissolvedAt: row.dissolved_at,
      memberIds: memberIdsByTopic.get(row.id) ?? [],
    }));
  }

  async saveTopics(runId: string, topics: TopicSaveInput[]): Promise<void> {
    if (topics.length === 0) {
      return;
    }
    await this.withTransaction(async (trx) => {
      const workspaceId = await this.requireRunWorkspaceId(runId, trx);
      if (topics.some((topic) => topic.workspaceId !== workspaceId)) {
        throw new Error("topic_repository: topic workspace does not match census run workspace");
      }
      await this.assertTopicsBelongToWorkspace(trx, workspaceId, topics.map((topic) => topic.id));
      for (const batch of chunk(topics, BATCH_SIZE)) {
        await trx
          .insertInto("topics")
          .values(
            batch.map((topic) => ({
              id: topic.id,
              workspace_id: topic.workspaceId,
              centroid: sql<string>`${serializeVector(topic.centroid)}::vector`,
              dimensions: topic.centroid.length,
              radius: topic.radius,
              // Empty-string sentinel: NOT NULL columns, but "not supplied" must mean
              // "keep the current name" on update (see the doUpdateSet coalesce below),
              // not "insert null". A brand-new topic with no name lands with "" pending
              // naming.
              title: topic.title ?? "",
              description: topic.description ?? "",
              created_run_id: runId,
              last_seen_run_id: runId,
            })),
          )
          .onConflict((oc) =>
            oc.column("id").doUpdateSet((eb) => ({
              centroid: eb.ref("excluded.centroid"),
              dimensions: eb.ref("excluded.dimensions"),
              radius: eb.ref("excluded.radius"),
              last_seen_run_id: eb.ref("excluded.last_seen_run_id"),
              dissolved_at: null,
              title: sql<string>`coalesce(nullif(${eb.ref("excluded.title")}, ''), ${eb.ref("topics.title")})`,
              description: sql<string>`coalesce(nullif(${eb.ref("excluded.description")}, ''), ${eb.ref("topics.description")})`,
              updated_at: currentTimestamp(),
            })),
          )
          .execute();
      }
    });
  }

  async saveMemberships(runId: string, memberships: TopicMembershipInput[]): Promise<void> {
    if (memberships.length === 0) {
      return;
    }
    await this.withTransaction(async (trx) => {
      const workspaceId = await this.requireRunWorkspaceId(runId, trx);
      await this.assertTopicsBelongToWorkspace(
        trx,
        workspaceId,
        memberships.map((membership) => membership.topicId),
        { requireExisting: true },
      );
      await this.assertMessagesBelongToWorkspace(trx, workspaceId, memberships.map((membership) => membership.messageId));
      for (const batch of chunk(memberships, BATCH_SIZE)) {
        await trx
          .insertInto("topic_memberships")
          .values(
            batch.map((membership) => ({
              workspace_id: workspaceId,
              run_id: runId,
              topic_id: membership.topicId,
              message_id: membership.messageId,
              distance: membership.distance,
            })),
          )
          .execute();
      }
    });
  }

  async saveTransitions(runId: string, transitions: TopicTransitionInput[]): Promise<void> {
    if (transitions.length === 0) {
      return;
    }
    await this.withTransaction(async (trx) => {
      const workspaceId = await this.requireRunWorkspaceId(runId, trx);
      await this.assertTopicsBelongToWorkspace(
        trx,
        workspaceId,
        transitions.flatMap((transition) => [
          transition.topicId,
          ...transition.parentTopicIds,
        ]),
        { requireExisting: true },
      );
      for (const batch of chunk(transitions, BATCH_SIZE)) {
        await trx
          .insertInto("topic_transitions")
          .values(
            batch.map((transition) => ({
              workspace_id: workspaceId,
              run_id: runId,
              topic_id: transition.topicId,
              kind: transition.kind,
              parent_topic_ids: transition.parentTopicIds,
              via_centroid_fallback: transition.viaCentroidFallback ?? false,
            })),
          )
          .execute();
      }
    });
  }

  async markDissolved(runId: string, topicIds: string[]): Promise<void> {
    if (topicIds.length === 0) {
      return;
    }
    await this.withTransaction(async (trx) => {
      const workspaceId = await this.requireRunWorkspaceId(runId, trx);
      await this.assertTopicsBelongToWorkspace(trx, workspaceId, topicIds, { requireExisting: true });
      await trx
        .updateTable("topics")
        .set({
          dissolved_at: currentTimestamp(),
          last_seen_run_id: runId,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", topicIds)
        .execute();
    });
  }

  async loadRun(runId: string): Promise<TopicCensusRunDetail | null> {
    const run = await this.db
      .selectFrom("topic_census_runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirst();
    return run ? this.hydrateRun(run) : null;
  }

  async loadLatestRun(workspaceId: string): Promise<TopicCensusRunDetail | null> {
    const run = await this.db
      .selectFrom("topic_census_runs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return run ? this.hydrateRun(run) : null;
  }

  private async hydrateRun(run: TopicCensusRunRow): Promise<TopicCensusRunDetail> {
    const topicRows = await this.db
      .selectFrom("topic_memberships")
      .innerJoin("topics", "topics.id", "topic_memberships.topic_id")
      .select([
        "topics.id as id",
        "topics.title as title",
        "topics.description as description",
        "topics.centroid as centroid",
        "topics.radius as radius",
        "topics.dissolved_at as dissolved_at",
        (eb) => eb.fn.countAll<string>().as("member_count"),
      ])
      .where("topic_memberships.run_id", "=", run.id)
      .groupBy("topics.id")
      .execute();

    // Transitions stay separate from the membership aggregate so counts remain
    // structurally independent of identity metadata. The database guarantees one row
    // per run/topic; ordering keeps the read deterministic across topics.
    const transitionRows = await this.db
      .selectFrom("topic_transitions")
      .select(["topic_id", "kind", "parent_topic_ids", "via_centroid_fallback", "created_at", "id"])
      .where("run_id", "=", run.id)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const transitionByTopicId = new Map(transitionRows.map((transition) => [transition.topic_id, transition]));

    const dissolvedTopics: TopicCensusRunDissolvedTopic[] = await this.db
      .selectFrom("topics")
      .select(["id", "title"])
      .where("workspace_id", "=", run.workspace_id)
      .where("last_seen_run_id", "=", run.id)
      .where("dissolved_at", "is not", null)
      .orderBy("dissolved_at", "asc")
      .orderBy("id", "asc")
      .execute();

    const topics: TopicCensusRunTopicSummary[] = topicRows
      .map((topic) => {
        const transition = transitionByTopicId.get(topic.id);
        return {
          id: topic.id,
          title: topic.title,
          description: topic.description,
          centroid: parseVector(topic.centroid),
          radius: topic.radius,
          dissolvedAt: topic.dissolved_at,
          memberCount: Number(topic.member_count),
          transition: transition === undefined ? null : {
            kind: transition.kind as TopicTransitionKind,
            parentTopicIds: transition.parent_topic_ids ?? [],
            viaCentroidFallback: transition.via_centroid_fallback ?? false,
          },
        };
      })
      .sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));

    return {
      id: run.id,
      workspaceId: run.workspace_id,
      windowStart: run.window_start,
      windowEnd: run.window_end,
      questionCount: run.question_count,
      unclassifiedCount: run.unclassified_count,
      seed: run.seed,
      params: run.params_json as Record<string, unknown>,
      createdAt: run.created_at,
      topics,
      dissolvedTopics,
    };
  }
}
