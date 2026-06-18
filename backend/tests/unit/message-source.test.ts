import { describe, expect, it } from "vitest";

import {
  deriveMessageSourceFromRole,
  mapMessageRow,
  MessageRepository,
  type MessageRow,
} from "../../src/db/repositories/messageRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

const row = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: "message-1",
  conversation_id: "conversation-1",
  workspace_id: "workspace-1",
  role: "user",
  content: "Hello",
  source: null,
  metadata_json: {},
  skill_name: null,
  skill_outcome: null,
  skill_status: null,
  created_at: new Date("2026-06-17T10:00:00.000Z"),
  ...overrides,
});

describe("message source discriminator", () => {
  it("returns the stored source when present", () => {
    expect(mapMessageRow(row({ role: "assistant", source: "human_agent" })).source).toBe("human_agent");
  });

  it("derives source from role for legacy rows without a stored source", () => {
    expect(mapMessageRow(row({ role: "user", source: null })).source).toBe("customer");
    expect(mapMessageRow(row({ role: "assistant", source: null })).source).toBe("ai_agent");
    expect(mapMessageRow(row({ role: "system", source: null })).source).toBe("system");
  });

  it("derives write source from the persisted role", () => {
    expect(deriveMessageSourceFromRole("user")).toBe("customer");
    expect(deriveMessageSourceFromRole("assistant")).toBe("ai_agent");
    expect(deriveMessageSourceFromRole("system")).toBe("system");
  });

  it("stamps inserted messages with source derived from role", async () => {
    let insertParams: unknown[] = [];
    const database = {
      async query<T = Record<string, unknown>>(_text: string, params: unknown[]): Promise<T[]> {
        insertParams = params;
        return [{
          id: String(params[0]),
          conversation_id: String(params[1]),
          workspace_id: String(params[2]),
          role: params[3],
          content: String(params[4]),
          source: params[5],
          metadata_json: JSON.parse(String(params[6])) as Record<string, unknown>,
          skill_name: null,
          skill_outcome: null,
          skill_status: null,
          created_at: new Date("2026-06-17T10:00:00.000Z"),
        } as T];
      },
    } as unknown as Database;
    const repository = new MessageRepository(database);

    const message = await repository.create({
      id: "message-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      role: "assistant",
      content: "Done.",
    });

    expect(insertParams[5]).toBe("ai_agent");
    expect(message.source).toBe("ai_agent");
  });

  it("persists an explicit source override and human operator metadata", async () => {
    let insertParams: unknown[] = [];
    const database = {
      async query<T = Record<string, unknown>>(_text: string, params: unknown[]): Promise<T[]> {
        insertParams = params;
        return [{
          id: String(params[0]),
          conversation_id: String(params[1]),
          workspace_id: String(params[2]),
          role: params[3],
          content: String(params[4]),
          source: params[5],
          metadata_json: JSON.parse(String(params[6])) as Record<string, unknown>,
          skill_name: null,
          skill_outcome: null,
          skill_status: null,
          created_at: new Date("2026-06-17T10:00:00.000Z"),
        } as T];
      },
    } as unknown as Database;
    const repository = new MessageRepository(database);

    const message = await repository.create({
      id: "message-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      role: "assistant",
      source: "human_agent",
      content: "A human answered.",
      operatorAccountId: "account-1",
      operatorDisplayName: "Dana Operator",
    });

    expect(insertParams[5]).toBe("human_agent");
    expect(JSON.parse(String(insertParams[6]))).toEqual({
      humanAgent: {
        accountId: "account-1",
        displayName: "Dana Operator",
      },
    });
    expect(message.source).toBe("human_agent");
    expect(message.metadata).toEqual({
      humanAgent: {
        accountId: "account-1",
        displayName: "Dana Operator",
      },
    });
  });
});
