import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { TopicRepository } from "../../../src/db/repositories/topicRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("TopicRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new TopicRepository(database.kysely);
  const accountId = randomUUID();

  const ensureWorkspace = async (workspaceId: string): Promise<void> => {
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, accountId, `Topic Repository Workspace ${workspaceId}`, `topic-repo-${workspaceId}`],
    );
  };

  const createMessages = async (workspaceId: string, count: number): Promise<string[]> => {
    await ensureWorkspace(workspaceId);
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const messageId = randomUUID();
      ids.push(messageId);
      await database.query(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
         VALUES ($1, $2, $3, 'user', $4)`,
        [messageId, conversationId, workspaceId, `topic repository message ${index}`],
      );
    }
    return ids;
  };

  const createRun = async (workspaceId: string, overrides: Partial<{
    windowStart: Date;
    windowEnd: Date;
    questionCount: number;
    unclassifiedCount: number;
    seed: string;
    params: Record<string, unknown>;
  }> = {}): Promise<string> => {
    await ensureWorkspace(workspaceId);
    return repository.createRun({
      workspaceId,
      windowStart: overrides.windowStart ?? new Date("2026-07-01T00:00:00.000Z"),
      windowEnd: overrides.windowEnd ?? new Date("2026-07-31T00:00:00.000Z"),
      questionCount: overrides.questionCount ?? 10,
      unclassifiedCount: overrides.unclassifiedCount ?? 1,
      seed: overrides.seed ?? "seed-1",
      params: overrides.params ?? { k: 3 },
    });
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Topic Repository Test", `topic-repo-${accountId}@example.com`, "hash"],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM workspaces WHERE account_id = $1", [accountId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("createRun persists the run and loadRun reads it back", async () => {
    const workspaceId = randomUUID();
    const windowStart = new Date("2026-07-01T00:00:00.000Z");
    const windowEnd = new Date("2026-07-31T00:00:00.000Z");

    const runId = await createRun(workspaceId, {
      windowStart,
      windowEnd,
      questionCount: 42,
      unclassifiedCount: 5,
      seed: "seed-abc",
      params: { targetMembers: 20, k: 4 },
    });

    const run = await repository.loadRun(runId);
    expect(run).not.toBeNull();
    expect(run?.workspaceId).toBe(workspaceId);
    expect(run?.windowStart.toISOString()).toBe(windowStart.toISOString());
    expect(run?.windowEnd.toISOString()).toBe(windowEnd.toISOString());
    expect(run?.questionCount).toBe(42);
    expect(run?.unclassifiedCount).toBe(5);
    expect(run?.seed).toBe("seed-abc");
    expect(run?.params).toEqual({ targetMembers: 20, k: 4 });
    expect(run?.topics).toEqual([]);
  });

  it("loadRun returns null for an unknown run id", async () => {
    expect(await repository.loadRun(randomUUID())).toBeNull();
  });

  it("loadLatestRun returns the most recently created run for a workspace", async () => {
    const workspaceId = randomUUID();
    await createRun(workspaceId, { seed: "older" });
    const newerRunId = await createRun(workspaceId, { seed: "newer" });

    const latest = await repository.loadLatestRun(workspaceId);

    expect(latest?.id).toBe(newerRunId);
    expect(latest?.seed).toBe("newer");
  });

  it("loadLatestRun returns null when the workspace has no runs", async () => {
    expect(await repository.loadLatestRun(randomUUID())).toBeNull();
  });

  it("listActiveTopics excludes dissolved topics and returns centroid as number[]", async () => {
    const workspaceId = randomUUID();
    const runId = await createRun(workspaceId);
    const survivingId = randomUUID();
    const dissolvingId = randomUUID();

    await repository.saveTopics(runId, [
      {
        id: survivingId,
        workspaceId,
        centroid: [0.1, 0.2, 0.3],
        radius: 0.5,
        title: "Billing questions",
        description: "Questions about invoices and payment methods",
      },
      {
        id: dissolvingId,
        workspaceId,
        centroid: [0.9, 0.8, 0.7],
        radius: 0.2,
        title: "One-off topic",
        description: "Should be dissolved",
      },
    ]);
    await repository.markDissolved(runId, [dissolvingId]);

    const active = await repository.listActiveTopics(workspaceId);

    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(survivingId);
    expect(active[0]!.title).toBe("Billing questions");
    expect(active[0]!.centroid).toHaveLength(3);
    active[0]!.centroid.forEach((value, index) => {
      expect(Math.abs(value - [0.1, 0.2, 0.3][index]!)).toBeLessThan(1e-4);
    });
  });

  it("listMatchableTopics includes dissolved topics so returning topics can be recognized", async () => {
    const workspaceId = randomUUID();
    const runId = await createRun(workspaceId);
    const topicId = randomUUID();
    await repository.saveTopics(runId, [{
      id: topicId,
      workspaceId,
      centroid: [0.1, 0.2, 0.3],
      radius: 0.5,
      title: "Returning topic",
      description: "Can return later",
    }]);
    await repository.markDissolved(runId, [topicId]);

    expect(await repository.listActiveTopics(workspaceId)).toEqual([]);
    expect((await repository.listMatchableTopics(workspaceId)).map((topic) => topic.id)).toEqual([topicId]);
  });

  it("saveTopics reactivates a dissolved topic when identity matching reuses its id", async () => {
    const workspaceId = randomUUID();
    const firstRunId = await createRun(workspaceId, { seed: "first-run" });
    const topicId = randomUUID();
    await repository.saveTopics(firstRunId, [{
      id: topicId,
      workspaceId,
      centroid: [0.1, 0.2, 0.3],
      radius: 0.5,
      title: "Returning topic",
      description: "Can return later",
    }]);
    await repository.markDissolved(firstRunId, [topicId]);

    const secondRunId = await createRun(workspaceId, { seed: "second-run" });
    await repository.saveTopics(secondRunId, [{
      id: topicId,
      workspaceId,
      centroid: [0.2, 0.3, 0.4],
      radius: 0.6,
    }]);

    const active = await repository.listActiveTopics(workspaceId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(topicId);
    expect(active[0]!.lastSeenRunId).toBe(secondRunId);
  });

  it("saveTopics updates a surviving topic and keeps its title/description when not supplied", async () => {
    const workspaceId = randomUUID();
    const firstRunId = await createRun(workspaceId, { seed: "run-1" });
    const topicId = randomUUID();
    await repository.saveTopics(firstRunId, [
      {
        id: topicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "Refund policy",
        description: "Questions about refunds",
      },
    ]);

    const secondRunId = await createRun(workspaceId, { seed: "run-2" });
    await repository.saveTopics(secondRunId, [
      {
        id: topicId,
        workspaceId,
        centroid: [0.2, 0.2, 0.2],
        radius: 0.4,
        // title/description omitted: should be preserved from the first run
      },
    ]);

    const active = await repository.listActiveTopics(workspaceId);
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe("Refund policy");
    expect(active[0]!.description).toBe("Questions about refunds");
    expect(active[0]!.lastSeenRunId).toBe(secondRunId);
    expect(active[0]!.createdRunId).toBe(firstRunId);
    active[0]!.centroid.forEach((value, index) => {
      expect(Math.abs(value - [0.2, 0.2, 0.2][index]!)).toBeLessThan(1e-4);
    });
  });

  it("saveTopics updates title/description when supplied", async () => {
    const workspaceId = randomUUID();
    const firstRunId = await createRun(workspaceId, { seed: "run-1" });
    const topicId = randomUUID();
    await repository.saveTopics(firstRunId, [
      {
        id: topicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "Old title",
        description: "Old description",
      },
    ]);

    const secondRunId = await createRun(workspaceId, { seed: "run-2" });
    await repository.saveTopics(secondRunId, [
      {
        id: topicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "New title",
        description: "New description",
      },
    ]);

    const active = await repository.listActiveTopics(workspaceId);
    expect(active[0]!.title).toBe("New title");
    expect(active[0]!.description).toBe("New description");
  });

  it("saves a full run (topics + memberships + transitions) in one transaction and reads it back via loadRun", async () => {
    const workspaceId = randomUUID();
    const runId = await createRun(workspaceId, { seed: "full-save" });
    const topicAId = randomUUID();
    const topicBId = randomUUID();
    const messageIds = await createMessages(workspaceId, 5);

    await database.kysely.transaction().execute(async (trx) => {
      const trxRepository = new TopicRepository(trx);
      await trxRepository.saveTopics(runId, [
        {
          id: topicAId,
          workspaceId,
          centroid: [0.1, 0.1, 0.1],
          radius: 0.3,
          title: "Topic A",
          description: "First topic",
        },
        {
          id: topicBId,
          workspaceId,
          centroid: [0.9, 0.9, 0.9],
          radius: 0.4,
          title: "Topic B",
          description: "Second topic",
        },
      ]);
      await trxRepository.saveMemberships(runId, [
        { topicId: topicAId, messageId: messageIds[0]!, distance: 0.01 },
        { topicId: topicAId, messageId: messageIds[1]!, distance: 0.02 },
        { topicId: topicAId, messageId: messageIds[2]!, distance: 0.03 },
        { topicId: topicBId, messageId: messageIds[3]!, distance: 0.04 },
        { topicId: topicBId, messageId: messageIds[4]!, distance: 0.05 },
      ]);
      await trxRepository.saveTransitions(runId, [
        { topicId: topicAId, kind: "emerged", parentTopicIds: [] },
        { topicId: topicBId, kind: "emerged", parentTopicIds: [] },
      ]);
    });

    const run = await repository.loadRun(runId);

    expect(run).not.toBeNull();
    expect(run?.topics).toHaveLength(2);
    const topicA = run?.topics.find((topic) => topic.id === topicAId);
    const topicB = run?.topics.find((topic) => topic.id === topicBId);
    expect(topicA?.memberCount).toBe(3);
    expect(topicB?.memberCount).toBe(2);
    expect(topicA?.title).toBe("Topic A");
    expect(topicA?.dissolvedAt).toBeNull();

    const transitionRows = await database.query<{ kind: string; topic_id: string }>(
      "SELECT kind, topic_id FROM topic_transitions WHERE run_id = $1 ORDER BY topic_id",
      [runId],
    );
    expect(transitionRows).toHaveLength(2);
    expect(transitionRows.every((row) => row.kind === "emerged")).toBe(true);
  });

  it("saves transitions with parent topic ids intact", async () => {
    const workspaceId = randomUUID();
    const parentRunId = await createRun(workspaceId, { seed: "parent-run" });
    const parentTopicId = randomUUID();
    await repository.saveTopics(parentRunId, [
      {
        id: parentTopicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "Parent topic",
        description: "Splits into two",
      },
    ]);

    const runId = await createRun(workspaceId, { seed: "split-run" });
    const childAId = randomUUID();
    const childBId = randomUUID();
    await repository.saveTopics(runId, [
      {
        id: childAId,
        workspaceId,
        centroid: [0.1, 0.0, 0.1],
        radius: 0.2,
        title: "Child A",
        description: "Split A",
      },
      {
        id: childBId,
        workspaceId,
        centroid: [0.1, 0.2, 0.1],
        radius: 0.2,
        title: "Child B",
        description: "Split B",
      },
    ]);
    await repository.saveTransitions(runId, [
      { topicId: childAId, kind: "split", parentTopicIds: [parentTopicId] },
      { topicId: childBId, kind: "split", parentTopicIds: [parentTopicId] },
    ]);

    const rows = await database.query<{ topic_id: string; parent_topic_ids: string[] }>(
      "SELECT topic_id, parent_topic_ids FROM topic_transitions WHERE run_id = $1 ORDER BY topic_id",
      [runId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.parent_topic_ids).toEqual([parentTopicId]);
    }
  });

  it("batches bulk membership inserts across more than one batch worth of rows", async () => {
    const workspaceId = randomUUID();
    const runId = await createRun(workspaceId, { seed: "bulk-run" });
    const topicId = randomUUID();
    await repository.saveTopics(runId, [
      {
        id: topicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "Bulk topic",
        description: "Receives many memberships",
      },
    ]);
    const messageIds = await createMessages(workspaceId, 1200);
    const memberships = messageIds.map((messageId) => ({
      topicId,
      messageId,
      distance: 0.01,
    }));

    await repository.saveMemberships(runId, memberships);

    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM topic_memberships WHERE run_id = $1",
      [runId],
    );
    expect(rows[0]!.count).toBe("1200");
  });

  it("saveRun persists the run, its topics, and its memberships atomically", async () => {
    const workspaceId = randomUUID();
    const topicAId = randomUUID();
    const topicBId = randomUUID();
    const messageIds = await createMessages(workspaceId, 3);

    const runId = await repository.saveRun({
      run: {
        workspaceId,
        windowStart: new Date("2026-07-01T00:00:00.000Z"),
        windowEnd: new Date("2026-07-31T00:00:00.000Z"),
        questionCount: 4,
        unclassifiedCount: 1,
        seed: "save-run-seed",
        params: { targetMembers: 20 },
      },
      topics: [
        {
          id: topicAId,
          workspaceId,
          centroid: [0.1, 0.1, 0.1],
          radius: 0.3,
          title: "Topic A",
          description: "First topic",
        },
        {
          id: topicBId,
          workspaceId,
          centroid: [0.9, 0.9, 0.9],
          radius: 0.4,
          title: "Topic B",
          description: "Second topic",
        },
      ],
      memberships: [
        { topicId: topicAId, messageId: messageIds[0]!, distance: 0.01 },
        { topicId: topicAId, messageId: messageIds[1]!, distance: 0.02 },
        { topicId: topicBId, messageId: messageIds[2]!, distance: 0.03 },
      ],
    });

    const run = await repository.loadRun(runId);
    expect(run?.questionCount).toBe(4);
    expect(run?.unclassifiedCount).toBe(1);
    expect(run?.seed).toBe("save-run-seed");
    expect(run?.topics).toHaveLength(2);
    const topicA = run?.topics.find((topic) => topic.id === topicAId);
    expect(topicA?.memberCount).toBe(2);
    expect(topicA?.title).toBe("Topic A");
  });

  it("saveRun persists transitions and marks dissolved topics atomically alongside the run", async () => {
    const workspaceId = randomUUID();
    const priorRunId = await createRun(workspaceId, { seed: "prior-run" });
    const oldTopicId = randomUUID();
    await repository.saveTopics(priorRunId, [
      {
        id: oldTopicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "Old topic",
        description: "Will dissolve",
      },
    ]);

    const newTopicId = randomUUID();
    const [messageId] = await createMessages(workspaceId, 1);
    const runId = await repository.saveRun({
      run: {
        workspaceId,
        windowStart: new Date("2026-07-01T00:00:00.000Z"),
        windowEnd: new Date("2026-07-31T00:00:00.000Z"),
        questionCount: 1,
        unclassifiedCount: 0,
        seed: "identity-save-run-seed",
        params: {},
      },
      topics: [
        {
          id: newTopicId,
          workspaceId,
          centroid: [0.5, 0.5, 0.5],
          radius: 0.2,
          title: "New topic",
          description: "Emerged this run",
        },
      ],
      memberships: [{ topicId: newTopicId, messageId: messageId!, distance: 0.01 }],
      transitions: [
        { topicId: newTopicId, kind: "emerged", parentTopicIds: [], viaCentroidFallback: false },
        { topicId: oldTopicId, kind: "dissolved", parentTopicIds: [], viaCentroidFallback: false },
      ],
      dissolvedTopicIds: [oldTopicId],
    });

    const transitionRows = await database.query<{ topic_id: string; kind: string; via_centroid_fallback: boolean }>(
      "SELECT topic_id, kind, via_centroid_fallback FROM topic_transitions WHERE run_id = $1 ORDER BY topic_id",
      [runId],
    );
    expect(transitionRows).toHaveLength(2);
    expect(transitionRows.find((row) => row.topic_id === newTopicId)?.kind).toBe("emerged");
    expect(transitionRows.find((row) => row.topic_id === oldTopicId)?.kind).toBe("dissolved");
    expect(transitionRows.every((row) => row.via_centroid_fallback === false)).toBe(true);

    const oldTopicRow = await database.query<{ dissolved_at: Date | null }>(
      "SELECT dissolved_at FROM topics WHERE id = $1",
      [oldTopicId],
    );
    expect(oldTopicRow[0]!.dissolved_at).not.toBeNull();

    const active = await repository.listActiveTopics(workspaceId);
    expect(active.map((topic) => topic.id)).toEqual([newTopicId]);
  });

  it("saveRun rolls back the run row when a later statement in the transaction fails", async () => {
    const workspaceId = randomUUID();
    const topicId = randomUUID();
    await ensureWorkspace(workspaceId);

    await expect(repository.saveRun({
      run: {
        workspaceId,
        windowStart: new Date("2026-07-01T00:00:00.000Z"),
        windowEnd: new Date("2026-07-31T00:00:00.000Z"),
        questionCount: 1,
        unclassifiedCount: 0,
        seed: "rollback-seed",
        params: {},
      },
      topics: [
        {
          id: topicId,
          workspaceId,
          centroid: [0.1, 0.1, 0.1],
          radius: 0.3,
          title: "Topic",
          description: "Will roll back",
        },
      ],
      // A membership referencing a topic id that was never saved trips the
      // topic_memberships FK, which must roll back the run and topic inserts too.
      memberships: [{ topicId: randomUUID(), messageId: randomUUID(), distance: 0.01 }],
    })).rejects.toThrow();

    const latest = await repository.loadLatestRun(workspaceId);
    expect(latest).toBeNull();
  });

  it("markDissolved sets dissolved_at", async () => {
    const workspaceId = randomUUID();
    const runId = await createRun(workspaceId);
    const topicId = randomUUID();
    await repository.saveTopics(runId, [
      {
        id: topicId,
        workspaceId,
        centroid: [0.1, 0.1, 0.1],
        radius: 0.3,
        title: "To dissolve",
        description: "Will be dissolved",
      },
    ]);

    await repository.markDissolved(runId, [topicId]);

    const rows = await database.query<{ dissolved_at: Date | null }>(
      "SELECT dissolved_at FROM topics WHERE id = $1",
      [topicId],
    );
    expect(rows[0]!.dissolved_at).not.toBeNull();
  });
});
