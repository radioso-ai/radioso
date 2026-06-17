import { describe, expect, it } from "vitest";

import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

describe("message repository", () => {
  it("round-trips nested activity trace metadata through JSON serialization", async () => {
    const database = {
      async query<T = Record<string, unknown>>(_text: string, params: unknown[]): Promise<T[]> {
        const metadata = JSON.parse(String(params[6])) as Record<string, unknown>;
        return [{
          id: String(params[0]),
          conversation_id: String(params[1]),
          workspace_id: String(params[2]),
          role: params[3],
          content: String(params[4]),
          source: params[5],
          metadata_json: metadata,
          created_at: new Date("2026-05-04T10:00:00.000Z"),
        } as T];
      },
    } as unknown as Database;
    const repository = new MessageRepository(database);
    const activityTrace = {
      traceId: "trace-1",
      startedAt: "2026-05-04T10:00:00.000Z",
      completedAt: "2026-05-04T10:00:01.000Z",
      stages: [
        {
          stageId: "intake_collect",
          kind: "intake_collect",
          label: "Intake collect",
          status: "applied",
          outputs: {
            collected: ["email"],
            nested: {
              delivery: {
                destinations: ["email", "webhook"],
              },
            },
          },
        },
      ],
      links: [
        {
          fromStageId: "intake_collect",
          toStageId: "skill_execute",
          kind: "sequence",
        },
      ],
      summary: {
        traceId: "trace-1",
        skillName: "human_contact.request",
        status: "success",
        outcome: "request_submitted",
      },
    };

    const message = await repository.create({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      role: "assistant",
      content: "Done.",
      metadata: {
        skillIntake: {
          skillName: "human_contact.request",
          status: "completed",
          stateId: "state-1",
        },
        activityTrace,
      },
    });

    expect(message.metadata).toEqual({
      skillIntake: {
        skillName: "human_contact.request",
        status: "completed",
        stateId: "state-1",
      },
      activityTrace,
    });
  });

  it("round-trips structured user intent metadata", async () => {
    const database = {
      async query<T = Record<string, unknown>>(_text: string, params: unknown[]): Promise<T[]> {
        const metadata = JSON.parse(String(params[6])) as Record<string, unknown>;
        return [{
          id: String(params[0]),
          conversation_id: String(params[1]),
          workspace_id: String(params[2]),
          role: params[3],
          content: String(params[4]),
          source: params[5],
          metadata_json: metadata,
          created_at: new Date("2026-05-04T10:00:00.000Z"),
        } as T];
      },
    } as unknown as Database;
    const repository = new MessageRepository(database);

    const message = await repository.create({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      role: "user",
      content: "Je souhaite parler à une personne.",
      inputMetadata: {
        method: "intent_click",
        intent: {
          skillName: "human_contact.request",
          intentName: "explicit_contact_request",
        },
      },
    });

    expect(message.inputMetadata).toEqual({
      method: "intent_click",
      intent: {
        skillName: "human_contact.request",
        intentName: "explicit_contact_request",
      },
    });
  });
});
