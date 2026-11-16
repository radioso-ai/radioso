import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { parseStoredInputMetadata } from "../../src/shared/domain/chatInputMetadata.js";
import { visibleMessageText } from "../../src/shared/domain/visibleMessageText.js";
import { Database } from "../../src/shared/infra/database.js";
import { visibleMessagePhotoCountSql, visibleMessageTextSql } from "../../src/shared/infra/kysely/sqlHelpers.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// `visibleMessageText` (TypeScript) and `visibleMessageTextSql` / `visibleMessagePhotoCountSql` (SQL)
// decide what a person reads of a stored user message: the one reads a parsed row, the other picks
// and matches rows in Postgres. They must agree on every shape a row can have.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const IMAGE_ID = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const READING = "A landscape photo of rolling countryside.";
const block = (reading: string) => `<attached_photo index="1">${reading}</attached_photo>`;

const rows: Array<{ name: string; content: string; metadata: Record<string, unknown> }> = [
  { name: "plain", content: "What are your shop hours?", metadata: { method: "typed" } },
  {
    name: "photo plus text",
    content: `Something like this, please\n${block(READING)}`,
    metadata: { method: "typed", imageInput: { typedText: "Something like this, please", images: [{ id: IMAGE_ID, reading: READING }] } },
  },
  {
    name: "photo only",
    content: block(READING),
    metadata: { method: "typed", imageInput: { typedText: "", images: [{ id: IMAGE_ID, reading: READING }] } },
  },
  {
    name: "unreadable photos",
    content: "Do you have this?\n<attached_photo index=\"1\" status=\"unreadable\"/>\n<attached_photo index=\"2\" status=\"unreadable\"/>",
    metadata: { method: "typed", imageInput: { typedText: "Do you have this?", images: [{ id: IMAGE_ID, reading: null }, { id: IMAGE_ID, reading: null }] } },
  },
  { name: "no metadata", content: "Hello", metadata: {} },
  {
    name: "routine invocation",
    content: "{\"orderId\":\"A-100\"}",
    metadata: { method: "routine_invocation", routine: { toolName: "lookup_order", input: { orderId: "A-100" } } },
  },
  {
    name: "malformed typed text",
    content: `hi\n${block(READING)}`,
    metadata: { method: "typed", imageInput: { typedText: 4, images: [{ id: IMAGE_ID, reading: READING }] } },
  },
  {
    name: "no photos listed",
    content: "Just words",
    metadata: { method: "typed", imageInput: { typedText: "Just words", images: [] } },
  },
];

describeIntegration("visibleMessageText and its SQL twin (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const idByName = new Map<string, string>();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [accountId, "Twin Co", `twin-${accountId}@example.com`, "hash"]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [workspaceId, accountId, "Twin WS", `route-${workspaceId}`]);
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [conversationId, workspaceId]);
    for (const row of rows) {
      const id = randomUUID();
      idByName.set(row.name, id);
      await database.query(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json) VALUES ($1,$2,$3,'user',$4,$5::jsonb)`,
        [id, conversationId, workspaceId, row.content, JSON.stringify(row.metadata)],
      );
    }
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it.each(rows.map((row) => [row.name] as const))("agree on a %s message", async (name) => {
    const id = idByName.get(name)!;
    const stored = await database.kysely
      .selectFrom("messages")
      .select([
        "content",
        "metadata_json",
        visibleMessageTextSql(sql.ref("content"), sql.ref("metadata_json")).as("sql_text"),
        visibleMessagePhotoCountSql(sql.ref("metadata_json")).as("sql_photo_count"),
      ])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    const expected = visibleMessageText({ content: stored.content, inputMetadata: parseStoredInputMetadata(stored.metadata_json) });

    expect({ text: stored.sql_text, photoCount: Number(stored.sql_photo_count) }).toEqual(expected);
  });

  it("reads each shape as a person should, so agreement is not agreement on the wrong answer", async () => {
    const read = async (name: string) => {
      const stored = await database.kysely
        .selectFrom("messages")
        .select([visibleMessageTextSql(sql.ref("content"), sql.ref("metadata_json")).as("text"), visibleMessagePhotoCountSql(sql.ref("metadata_json")).as("photos")])
        .where("id", "=", idByName.get(name)!)
        .executeTakeFirstOrThrow();
      return { text: stored.text, photos: Number(stored.photos) };
    };

    expect(await read("photo plus text")).toEqual({ text: "Something like this, please", photos: 1 });
    expect(await read("photo only")).toEqual({ text: "", photos: 1 });
    expect(await read("unreadable photos")).toEqual({ text: "Do you have this?", photos: 2 });
    expect(await read("plain")).toEqual({ text: "What are your shop hours?", photos: 0 });
  });
});
