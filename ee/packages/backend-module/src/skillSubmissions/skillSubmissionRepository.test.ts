import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { humanContactRequestSkillDefinition } from "../humanContact/skill/definition.js";
import {
  SkillSubmissionRepository,
  type SkillSubmissionRow,
} from "./skillSubmissionRepository.js";

class FakeSkillSubmissionRepositoryDatabase implements UsageLimitDatabasePort {
  readonly rows = new Map<string, SkillSubmissionRow>();

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("FROM skill_submissions") && text.includes("AND id = $2")) {
      const row = [...this.rows.values()].find((candidate) =>
        candidate.workspace_id === String(params[0]) && candidate.id === String(params[1])
      );
      return (row ? [row] : []) as T[];
    }

    if (text.includes("FROM skill_submissions") && text.includes("idempotency_key = $3")) {
      const row = [...this.rows.values()].find((candidate) =>
        candidate.workspace_id === String(params[0]) &&
        candidate.skill_name === String(params[1]) &&
        candidate.idempotency_key === String(params[2])
      );
      return (row ? [row] : []) as T[];
    }

    if (text.includes("UPDATE skill_submissions") && text.includes("SET status = 'delivering'")) {
      const maxAttempts = Number(params[0]);
      const limit = Number(params[1]);
      const skillName = params[2] === null ? null : String(params[2]);
      const dueRows = [...this.rows.values()]
        .filter((row) =>
          row.status === "pending" &&
          row.next_retry_at.getTime() <= Date.now() &&
          row.attempts < maxAttempts &&
          (!skillName || row.skill_name === skillName)
        )
        .sort((left, right) =>
          left.next_retry_at.getTime() - right.next_retry_at.getTime() ||
          left.created_at.getTime() - right.created_at.getTime()
        )
        .slice(0, limit);
      for (const row of dueRows) {
        row.status = "delivering";
      }
      return dueRows.map((row) => ({ ...row })) as T[];
    }

    if (text.includes("UPDATE skill_submissions") && text.includes("SET status = 'failed'")) {
      const row = this.rows.get(String(params[0]));
      if (row) {
        row.status = "failed";
        row.attempts += 1;
        row.final_delivery_error = String(params[1]);
        row.activity_trace = params[2] as SkillSubmissionRow["activity_trace"];
      }
      return [] as T[];
    }

    return [] as T[];
  }
}

const createRow = (overrides: Partial<SkillSubmissionRow> = {}): SkillSubmissionRow => ({
  id: "submission-1",
  account_id: "account-1",
  workspace_id: "workspace-1",
  conversation_id: "conversation-1",
  assistant_message_id: null,
  skill_name: "human_contact.request",
  source_channel: "authenticated_chat",
  source_origin: null,
  trigger_source: "explicit_user_request",
  trigger_reason: null,
  idempotency_key: null,
  fields: { email: " visitor@example.com ", message: "Please contact me." },
  subject_identity: "visitor@example.com",
  status: "pending",
  attempts: 0,
  next_retry_at: new Date("2020-01-01T00:00:00.000Z"),
  final_delivery_error: null,
  activity_trace: null,
  created_at: new Date("2020-01-01T00:00:00.000Z"),
  updated_at: new Date("2020-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("skill submission repository", () => {
  it("validates submission fields through the registered skill definition on reads", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    database.rows.set("submission-1", createRow({
      fields: JSON.stringify({ email: " visitor@example.com ", message: "Please contact me." }) as unknown as Record<string, unknown>,
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition]);

    const row = await repository.findById("workspace-1", "submission-1");

    expect(row?.fields).toMatchObject({
      email: "visitor@example.com",
      message: "Please contact me.",
    });
  });

  it("rejects stored fields that no longer match the skill definition", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    database.rows.set("submission-1", createRow({
      fields: { email: "not an email", message: "Please contact me." },
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition]);

    await expect(repository.findById("workspace-1", "submission-1")).rejects.toBeInstanceOf(ZodError);
  });

  it("can read invalid stored fields in passthrough mode for history surfaces", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    database.rows.set("submission-1", createRow({
      fields: { email: "not an email", message: "Please contact me." },
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition]);

    const row = await repository.findById("workspace-1", "submission-1", {
      fieldValidation: "passthrough",
    });

    expect(row?.fields).toEqual({
      email: "not an email",
      message: "Please contact me.",
    });
  });

  it("claims due deliveries only for the requested skill", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    database.rows.set("contact-submission", createRow({ id: "contact-submission" }));
    database.rows.set("other-submission", createRow({
      id: "other-submission",
      skill_name: "other.deferred_skill",
      fields: { payload: "value" },
      subject_identity: null,
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition]);

    const rows = await repository.claimDueDeliveries({
      maxAttempts: 8,
      limit: 10,
      skillName: "human_contact.request",
    });

    expect(rows.map((row) => row.id)).toEqual(["contact-submission"]);
    expect(database.rows.get("contact-submission")?.status).toBe("delivering");
    expect(database.rows.get("other-submission")?.status).toBe("pending");
  });

  it("fails invalid claimed rows instead of leaving them delivering", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    const logger = {
      error: vi.fn(),
    };
    const onInvalidClaim = vi.fn();
    database.rows.set("invalid-submission", createRow({
      id: "invalid-submission",
      fields: { email: "not an email", message: "Please contact me." },
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition], {
      logger,
      onInvalidClaim,
    });

    const rows = await repository.claimDueDeliveries({
      maxAttempts: 8,
      limit: 10,
      skillName: "human_contact.request",
    });

    expect(rows).toEqual([]);
    expect(database.rows.get("invalid-submission")).toMatchObject({
      status: "failed",
      attempts: 1,
      final_delivery_error: expect.stringContaining("failed validation"),
      activity_trace: expect.objectContaining({
        summary: expect.objectContaining({
          status: "failed",
          outcome: "stored_fields_validation_failed",
        }),
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "stored_field_validation",
            status: "failed",
            reason: expect.stringContaining("failed validation"),
          }),
        ]),
      }),
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "invalid-submission",
        workspaceId: "workspace-1",
        skillName: "human_contact.request",
        attempts: 1,
      }),
      "Stored skill submission fields failed validation during delivery claim",
    );
    expect(onInvalidClaim).toHaveBeenCalledWith(expect.objectContaining({
      row: expect.objectContaining({ id: "invalid-submission" }),
      reason: expect.stringContaining("failed validation"),
      activityTrace: expect.objectContaining({
        summary: expect.objectContaining({
          status: "failed",
          outcome: "stored_fields_validation_failed",
        }),
      }),
      error: expect.any(Error),
    }));
  });

  it("looks up idempotency keys within the requested skill scope", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    database.rows.set("contact-submission", createRow({
      id: "contact-submission",
      idempotency_key: "same-key",
    }));
    database.rows.set("other-submission", createRow({
      id: "other-submission",
      skill_name: "other.deferred_skill",
      idempotency_key: "same-key",
      fields: { payload: "value" },
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition]);

    const row = await repository.findByIdempotencyKey("workspace-1", "human_contact.request", "same-key");

    expect(row?.id).toBe("contact-submission");
  });

  it("can read idempotency matches in passthrough mode", async () => {
    const database = new FakeSkillSubmissionRepositoryDatabase();
    database.rows.set("contact-submission", createRow({
      id: "contact-submission",
      idempotency_key: "same-key",
      fields: { email: "not an email", message: "Please contact me." },
    }));
    const repository = new SkillSubmissionRepository(database, [humanContactRequestSkillDefinition]);

    const row = await repository.findByIdempotencyKey("workspace-1", "human_contact.request", "same-key", {
      fieldValidation: "passthrough",
    });

    expect(row?.fields).toEqual({
      email: "not an email",
      message: "Please contact me.",
    });
  });
});
