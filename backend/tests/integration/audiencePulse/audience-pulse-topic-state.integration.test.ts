import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AudiencePulseTopicStateRepository } from "../../../src/db/repositories/audiencePulseTopicStateRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AudiencePulseTopicStateRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AudiencePulseTopicStateRepository(database.kysely);
  const accountId = randomUUID();
  const userId = randomUUID();

  const createWorkspace = async (): Promise<string> => {
    const workspaceId = randomUUID();
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, `Topic State Workspace ${workspaceId}`, `topic-state-${workspaceId}`],
    );
    return workspaceId;
  };

  const createTopic = async (workspaceId: string): Promise<string> => {
    const runId = randomUUID();
    const topicId = randomUUID();
    await database.query(
      `INSERT INTO topic_census_runs (id, workspace_id, window_start, window_end, question_count, seed, params_json)
       VALUES ($1, $2, '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z', 0, 'seed', '{}'::jsonb)`,
      [runId, workspaceId],
    );
    await database.query(
      `INSERT INTO topics (id, workspace_id, centroid, dimensions, radius, title, description, created_run_id, last_seen_run_id)
       VALUES ($1, $2, '[1,0,0]'::vector, 3, 0.1, 'Opening hours', 'When the shop opens.', $3, $3)`,
      [topicId, workspaceId, runId],
    );
    return topicId;
  };

  const createDocument = async (workspaceId: string): Promise<string> => {
    const documentId = randomUUID();
    await database.query(
      "INSERT INTO documents (id, title, source_content, markdown_content, status, workspace_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [documentId, "Opening hours", "Open daily.", "Open daily.", "ready", workspaceId],
    );
    return documentId;
  };

  const backdateDraft = async (topicId: string, documentId: string, createdAt: string): Promise<void> => {
    await database.query(
      "UPDATE audience_pulse_topic_drafts SET created_at = $3 WHERE topic_id = $1 AND document_id = $2",
      [topicId, documentId, createdAt],
    );
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Topic State Test", `topic-state-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
      [userId, `topic-state-user-${userId}@example.com`, "hash"],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  describe("dismissals", () => {
    it("dismisses and restores a topic once each, and reads the dismissal back", async () => {
      const workspaceId = await createWorkspace();
      const topicId = await createTopic(workspaceId);

      await expect(repository.dismiss({ workspaceId, topicId, userId })).resolves.toBe("changed");
      await expect(repository.dismiss({ workspaceId, topicId, userId })).resolves.toBe("unchanged");
      const states = await repository.readTopicStates({ workspaceId, topicIds: [topicId] });
      expect(states.get(topicId)).toEqual({ dismissedAt: expect.any(Date), latestDraft: null });

      await expect(repository.restore({ workspaceId, topicId })).resolves.toBe("changed");
      await expect(repository.restore({ workspaceId, topicId })).resolves.toBe("unchanged");
      await expect(repository.readTopicStates({ workspaceId, topicIds: [topicId] })).resolves.toEqual(new Map());
    });

    it("finds no topic that belongs to another workspace or does not exist", async () => {
      const workspaceId = await createWorkspace();
      const otherWorkspaceId = await createWorkspace();
      const otherTopicId = await createTopic(otherWorkspaceId);

      await expect(repository.dismiss({ workspaceId, topicId: otherTopicId, userId })).resolves.toBe("topic_not_found");
      await expect(repository.restore({ workspaceId, topicId: otherTopicId })).resolves.toBe("topic_not_found");
      await expect(repository.dismiss({ workspaceId, topicId: randomUUID(), userId })).resolves.toBe("topic_not_found");
      await expect(repository.readTopicStates({ workspaceId: otherWorkspaceId, topicIds: [otherTopicId] }))
        .resolves.toEqual(new Map());
    });
  });

  describe("draft links", () => {
    it("links a document once and reads the newest surviving draft", async () => {
      const workspaceId = await createWorkspace();
      const topicId = await createTopic(workspaceId);
      const olderDocumentId = await createDocument(workspaceId);
      const newerDocumentId = await createDocument(workspaceId);

      await expect(repository.linkDraft({ workspaceId, topicId, documentId: olderDocumentId, userId })).resolves.toBe("changed");
      await expect(repository.linkDraft({ workspaceId, topicId, documentId: olderDocumentId, userId })).resolves.toBe("unchanged");
      await expect(repository.linkDraft({ workspaceId, topicId, documentId: newerDocumentId, userId })).resolves.toBe("changed");
      await backdateDraft(topicId, olderDocumentId, "2026-07-10T00:00:00Z");
      await backdateDraft(topicId, newerDocumentId, "2026-07-12T00:00:00Z");

      expect((await repository.readTopicStates({ workspaceId, topicIds: [topicId] })).get(topicId)).toEqual({
        dismissedAt: null,
        latestDraft: { documentId: newerDocumentId, createdAt: new Date("2026-07-12T00:00:00Z") },
      });

      await database.query("DELETE FROM documents WHERE id = $1", [newerDocumentId]);
      expect((await repository.readTopicStates({ workspaceId, topicIds: [topicId] })).get(topicId)?.latestDraft)
        .toEqual({ documentId: olderDocumentId, createdAt: new Date("2026-07-10T00:00:00Z") });
    });

    it("refuses a topic or a document from another workspace", async () => {
      const workspaceId = await createWorkspace();
      const otherWorkspaceId = await createWorkspace();
      const topicId = await createTopic(workspaceId);
      const documentId = await createDocument(workspaceId);
      const otherTopicId = await createTopic(otherWorkspaceId);
      const otherDocumentId = await createDocument(otherWorkspaceId);

      await expect(repository.linkDraft({ workspaceId, topicId: otherTopicId, documentId, userId }))
        .resolves.toBe("topic_not_found");
      await expect(repository.linkDraft({ workspaceId, topicId, documentId: otherDocumentId, userId }))
        .resolves.toBe("document_not_found");
      await expect(repository.linkDraft({ workspaceId, topicId, documentId: randomUUID(), userId }))
        .resolves.toBe("document_not_found");
      await expect(repository.readTopicStates({ workspaceId, topicIds: [topicId] })).resolves.toEqual(new Map());
    });
  });

  it("reads only the topics asked for, and nothing for none", async () => {
    const workspaceId = await createWorkspace();
    const askedTopicId = await createTopic(workspaceId);
    const otherTopicId = await createTopic(workspaceId);
    await repository.dismiss({ workspaceId, topicId: askedTopicId, userId });
    await repository.dismiss({ workspaceId, topicId: otherTopicId, userId });

    expect([...(await repository.readTopicStates({ workspaceId, topicIds: [askedTopicId] })).keys()]).toEqual([askedTopicId]);
    await expect(repository.readTopicStates({ workspaceId, topicIds: [] })).resolves.toEqual(new Map());
  });

  it("goes with the topic and with the workspace", async () => {
    const workspaceId = await createWorkspace();
    const topicId = await createTopic(workspaceId);
    const survivingTopicId = await createTopic(workspaceId);
    const documentId = await createDocument(workspaceId);
    await repository.dismiss({ workspaceId, topicId, userId });
    await repository.linkDraft({ workspaceId, topicId, documentId, userId });
    await repository.dismiss({ workspaceId, topicId: survivingTopicId, userId });

    await database.query("DELETE FROM topics WHERE id = $1", [topicId]);
    const [afterTopicDelete] = await database.query<{ dismissals: string; drafts: string }>(
      `SELECT (SELECT count(*) FROM audience_pulse_topic_dismissals WHERE topic_id = $1)::text AS dismissals,
              (SELECT count(*) FROM audience_pulse_topic_drafts WHERE topic_id = $1)::text AS drafts`,
      [topicId],
    );
    expect(afterTopicDelete).toEqual({ dismissals: "0", drafts: "0" });

    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    const [afterWorkspaceDelete] = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audience_pulse_topic_dismissals WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(afterWorkspaceDelete?.count).toBe("0");
  });

  it("keeps a dismissal when the teammate who made it is deleted", async () => {
    const workspaceId = await createWorkspace();
    const topicId = await createTopic(workspaceId);
    const departingUserId = randomUUID();
    await database.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
      [departingUserId, `topic-state-departing-${departingUserId}@example.com`, "hash"],
    );
    await repository.dismiss({ workspaceId, topicId, userId: departingUserId });

    await database.query("DELETE FROM users WHERE id = $1", [departingUserId]);

    expect((await repository.readTopicStates({ workspaceId, topicIds: [topicId] })).get(topicId)?.dismissedAt)
      .toBeInstanceOf(Date);
  });
});
